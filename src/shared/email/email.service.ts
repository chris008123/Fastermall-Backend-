import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

@Injectable()
export class EmailService {
  private readonly logger = new Logger('EmailService');
  private transporter: nodemailer.Transporter;

  constructor(private config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('email.host'),
      port: this.config.get<number>('email.port'),
      secure: this.config.get<number>('email.port') === 465,
      auth: {
        user: this.config.get<string>('email.user'),
        pass: this.config.get<string>('email.pass'),
      },
    });
  }

  async sendOtpEmail(to: string, code: string) {
    try {
      await this.transporter.sendMail({
        from: this.config.get<string>('email.from'),
        to,
        subject: 'Your Fastermall verification code',
        text: `Your verification code is ${code}. It expires in 10 minutes.`,
        html: `
          <div style="font-family: sans-serif; padding: 24px;">
            <h2>Verify your email</h2>
            <p>Your Fastermall verification code is:</p>
            <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px;">${code}</p>
            <p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
          </div>
        `,
      });
    } catch (error) {
      // Don't let an email provider outage break registration entirely —
      // log it loudly so it's caught, but the OTP row still exists so the
      // user can request a resend once the issue is fixed.
      this.logger.error(`Failed to send OTP email to ${to}`, error);
      throw error;
    }
  }

  /**
   * Tells an approved delivery partner how to sign in. The temporary password
   * an admin set is included so they can start; they are asked to change it.
   */
  async sendPartnerApprovedEmail(to: string, details: { fullName: string; password: string; motorcycle: boolean }) {
    const name = escapeHtml(details.fullName.split(/\s+/)[0] || details.fullName);
    const docs = details.motorcycle
      ? 'your Ghana Card, a selfie, your driver’s licence, vehicle registration and insurance'
      : 'your Ghana Card and a selfie';
    try {
      await this.transporter.sendMail({
        from: this.config.get<string>('email.from'),
        to,
        subject: 'You’re approved to deliver with Fastermall',
        text: [
          `Hi ${details.fullName.split(/\s+/)[0] || details.fullName},`,
          '',
          'Your application to deliver with Fastermall has been approved.',
          '',
          'Sign in to the Fastermall Delivery app with:',
          `Email: ${to}`,
          `Temporary password: ${details.password}`,
          '',
          `Then go to Settings > Security to change your password, and upload ${docs} from Documents.`,
          'You can take deliveries once your documents are approved.',
          '',
          'If you didn’t apply, reply to this email and we’ll close the account.',
        ].join('\n'),
        html: `
          <div style="font-family: sans-serif; padding: 24px; max-width: 520px;">
            <h2>You’re approved, ${name}</h2>
            <p>Your application to deliver with Fastermall has been approved. Sign in to the Fastermall Delivery app with:</p>
            <p style="font-size: 16px;">Email: <strong>${escapeHtml(to)}</strong><br />
            Temporary password: <strong style="font-family: monospace; font-size: 18px; letter-spacing: 1px;">${escapeHtml(details.password)}</strong></p>
            <p>Then go to <strong>Settings &gt; Security</strong> to change your password, and upload ${docs} from <strong>Documents</strong>. You can take deliveries once your documents are approved.</p>
            <p style="color: #666;">If you didn’t apply, reply to this email and we’ll close the account.</p>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Failed to send partner approval email to ${to}`, error);
      throw error;
    }
  }

  async sendPasswordResetEmail(to: string, code: string) {
    try {
      await this.transporter.sendMail({
        from: this.config.get<string>('email.from'),
        to,
        subject: 'Reset your Fastermall password',
        text: `Your password reset code is ${code}. It expires in 15 minutes. If you didn't ask for this, you can ignore this email.`,
        html: `
          <div style="font-family: sans-serif; padding: 24px;">
            <h2>Reset your password</h2>
            <p>Your Fastermall password reset code is:</p>
            <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px;">${code}</p>
            <p>This code expires in 15 minutes. If you didn't ask for this, you can ignore this email — your password won't change.</p>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${to}`, error);
      throw error;
    }
  }
}
