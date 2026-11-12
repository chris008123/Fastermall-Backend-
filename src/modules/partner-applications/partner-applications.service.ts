import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DeliveryPartnerType, PartnerApplicationStatus, Prisma, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { EmailService } from '../../shared/email/email.service';
import { CreatePartnerApplicationDto } from './dto/partner-application.dto';

const MIN_AGE = 18;

/** Whole years between `birth` and `now` (UTC dates). Exported for tests. */
export function ageOn(birth: Date, now: Date): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Applications to become a delivery partner. Applying needs no account; an
 * admin approves (which creates the DELIVERY_PARTNER staff account with a
 * temporary password the admin passes on) or rejects with a reason.
 */
@Injectable()
export class PartnerApplicationsService {
  private readonly logger = new Logger(PartnerApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  // What the applicant's app gets back: nothing about other applications.
  private receipt(a: { id: string; status: PartnerApplicationStatus; createdAt: Date }) {
    return { id: a.id, status: a.status, createdAt: a.createdAt };
  }

  async apply(dto: CreatePartnerApplicationDto, now: Date = new Date()) {
    const birth = new Date(`${dto.dateOfBirth}T00:00:00Z`);
    if (Number.isNaN(birth.getTime()) || birth > now) {
      throw new BadRequestException({ message: 'Enter a real date of birth', code: 'INVALID_DATE_OF_BIRTH' });
    }
    if (ageOn(birth, now) < MIN_AGE) {
      throw new BadRequestException({ message: `Delivery partners must be at least ${MIN_AGE}`, code: 'TOO_YOUNG' });
    }

    const account = await this.prisma.staffUser.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { id: true },
    });
    if (account) {
      throw new ConflictException({
        message: 'This email or phone number already has a Fastermall account. Sign in instead.',
        code: 'ACCOUNT_EXISTS',
      });
    }

    const pending = await this.prisma.partnerApplication.findFirst({
      where: { status: PartnerApplicationStatus.PENDING, OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException({
        message: 'You already have an application waiting for review. We will contact you.',
        code: 'APPLICATION_PENDING',
      });
    }

    const created = await this.prisma.partnerApplication.create({
      data: {
        fullName: dto.fullName,
        email: dto.email,
        phone: dto.phone,
        dateOfBirth: birth,
        address: dto.address,
        partnerType: dto.partnerType,
        plateNumber: dto.partnerType === DeliveryPartnerType.MOTORCYCLE ? dto.plateNumber ?? null : null,
      },
    });
    return this.receipt(created);
  }

  list(status?: PartnerApplicationStatus) {
    return this.prisma.partnerApplication.findMany({
      where: status ? { status } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  }

  /**
   * Creates the partner's staff account and marks the application approved,
   * in one transaction: if either fails, neither happens. A second approval
   * (another admin at the same moment) is refused.
   */
  async approve(id: string, adminId: string, password: string) {
    const result = await this.createAccount(id, adminId, password);
    // Best effort: the account exists either way. The console tells the admin
    // to pass the details on by hand when this is false.
    let emailSent = false;
    try {
      await this.email.sendPartnerApprovedEmail(result.account.email ?? '', {
        fullName: result.account.fullName,
        password,
        motorcycle: result.application.partnerType === DeliveryPartnerType.MOTORCYCLE,
      });
      emailSent = true;
    } catch {
      this.logger.warn(`Approval email not sent for application ${id}`);
    }
    return { ...result, emailSent };
  }

  private async createAccount(id: string, adminId: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 10);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const app = await tx.partnerApplication.findUnique({ where: { id } });
        if (!app) throw new NotFoundException('Application not found');
        if (app.status !== PartnerApplicationStatus.PENDING) {
          throw new ConflictException({ message: `This application is already ${app.status.toLowerCase()}`, code: 'APPLICATION_REVIEWED' });
        }

        const staffUser = await tx.staffUser.create({
          data: {
            email: app.email,
            phone: app.phone,
            fullName: app.fullName,
            role: StaffRole.DELIVERY_PARTNER,
            passwordHash,
          },
        });
        await tx.deliveryPartnerProfile.create({ data: { staffUserId: staffUser.id, type: app.partnerType } });

        const marked = await tx.partnerApplication.updateMany({
          where: { id, status: PartnerApplicationStatus.PENDING },
          data: {
            status: PartnerApplicationStatus.APPROVED,
            reviewedById: adminId,
            reviewedAt: new Date(),
            staffUserId: staffUser.id,
          },
        });
        if (marked.count === 0) {
          throw new ConflictException({ message: 'This application was just reviewed', code: 'APPLICATION_REVIEWED' });
        }

        return {
          application: await tx.partnerApplication.findUniqueOrThrow({ where: { id } }),
          account: { id: staffUser.id, email: staffUser.email, fullName: staffUser.fullName },
        };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          message: 'A staff account with this email or phone number already exists',
          code: 'ACCOUNT_EXISTS',
        });
      }
      throw e;
    }
  }

  async reject(id: string, adminId: string, reason: string) {
    const marked = await this.prisma.partnerApplication.updateMany({
      where: { id, status: PartnerApplicationStatus.PENDING },
      data: { status: PartnerApplicationStatus.REJECTED, rejectionReason: reason, reviewedById: adminId, reviewedAt: new Date() },
    });
    if (marked.count === 0) {
      const exists = await this.prisma.partnerApplication.findUnique({ where: { id }, select: { status: true } });
      if (!exists) throw new NotFoundException('Application not found');
      throw new ConflictException({ message: `This application is already ${exists.status.toLowerCase()}`, code: 'APPLICATION_REVIEWED' });
    }
    return this.prisma.partnerApplication.findUniqueOrThrow({ where: { id } });
  }
}
