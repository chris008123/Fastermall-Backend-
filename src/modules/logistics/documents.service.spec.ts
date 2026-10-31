import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DocumentsService } from './documents.service';

describe('DocumentsService', () => {
  let svc: DocumentsService;
  let prisma: any;
  let storage: any;
  let events: { emit: jest.Mock };
  let settings: Record<string, unknown>;
  const config: any = { get: (k: string) => settings[k] };
  const profile = { id: 'p1', type: 'MOTORCYCLE', staffUserId: 's1' };
  const future = new Date(Date.now() + 200 * 24 * 3600 * 1000);
  const doc = (over: any = {}) => ({ id: 'doc1', partnerId: 'p1', type: 'ID_CARD', status: 'UPLOADING', storagePath: 'partners/p1/doc1.jpg', contentType: 'image/jpeg', sizeBytes: 1000, expiresAt: null, rejectionReason: null, createdAt: new Date(), ...over });

  beforeEach(() => {
    settings = { 'documents.maxBytes': 5 * 1024 * 1024, 'documents.requireVerification': false };
    prisma = {
      deliveryPartnerProfile: { findUnique: jest.fn().mockResolvedValue(profile) },
      partnerDocument: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(doc({ ...data, id: 'doc1' }))),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(doc(data))),
        findFirst: jest.fn().mockResolvedValue(doc()),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue(doc({ status: 'APPROVED' })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    storage = {
      bucket: 'partner-documents',
      createSignedUpload: jest.fn().mockResolvedValue({ signedUrl: 'https://s/upload', token: 'tok', path: 'partners/p1/doc1.jpg' }),
      stat: jest.fn().mockResolvedValue({ size: 2000, contentType: 'image/jpeg' }),
      remove: jest.fn().mockResolvedValue(undefined),
      createSignedDownload: jest.fn().mockResolvedValue('https://s/download?t=1'),
    };
    events = { emit: jest.fn() };
    svc = new DocumentsService(prisma, storage, config, events as unknown as EventEmitter2);
  });

  describe('createUpload', () => {
    it('makes a record, builds the path from our ids, and returns a signed upload without the path in the document', async () => {
      const out: any = await svc.createUpload('s1', { type: 'ID_CARD', contentType: 'image/jpeg', sizeBytes: 1000 } as any);
      expect(storage.createSignedUpload).toHaveBeenCalledWith('partners/p1/doc1.jpg');
      expect(out.upload).toMatchObject({ url: 'https://s/upload', token: 'tok', maxBytes: 5242880 });
      expect(out.document).not.toHaveProperty('storagePath');
      expect(out.document.status).toBe('UPLOADING');
    });

    it.each([
      ['too large', { type: 'ID_CARD', contentType: 'image/jpeg', sizeBytes: 6 * 1024 * 1024 }, 'FILE_TOO_LARGE'],
      ['a PDF for a photo', { type: 'PROFILE_PHOTO', contentType: 'application/pdf', sizeBytes: 1000 }, 'IMAGE_REQUIRED'],
      ['already expired', { type: 'INSURANCE', contentType: 'application/pdf', sizeBytes: 1000, expiresAt: '2020-01-01' }, 'DOCUMENT_EXPIRED'],
    ])('refuses: %s', async (_n, dto, code) => {
      const err: any = await svc.createUpload('s1', dto as any).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse().code).toBe(code);
      expect(prisma.partnerDocument.create).not.toHaveBeenCalled();
    });

    it('requires an expiry date for a licence', async () => {
      const err: any = await svc.createUpload('s1', { type: 'DRIVERS_LICENSE', contentType: 'image/png', sizeBytes: 1000 } as any).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe('EXPIRY_REQUIRED');
    });

    it('limits how many documents one partner can hold', async () => {
      prisma.partnerDocument.count.mockResolvedValue(15);
      await expect(svc.createUpload('s1', { type: 'ID_CARD', contentType: 'image/jpeg', sizeBytes: 1 } as any)).rejects.toBeInstanceOf(ConflictException);
    });

    it('removes the record if storage is down', async () => {
      storage.createSignedUpload.mockRejectedValue(new Error('down'));
      await expect(svc.createUpload('s1', { type: 'ID_CARD', contentType: 'image/jpeg', sizeBytes: 1 } as any)).rejects.toThrow('down');
      expect(prisma.partnerDocument.delete).toHaveBeenCalledWith({ where: { id: 'doc1' } });
    });
  });

  describe('completeUpload', () => {
    it('checks the real file and queues it for review', async () => {
      const out: any = await svc.completeUpload('s1', 'doc1');
      expect(prisma.partnerDocument.update).toHaveBeenCalledWith({ where: { id: 'doc1' }, data: { status: 'PENDING', sizeBytes: 2000 } });
      expect(out.status).toBe('PENDING');
    });

    it('is safe to call twice', async () => {
      prisma.partnerDocument.findFirst.mockResolvedValue(doc({ status: 'PENDING' }));
      await svc.completeUpload('s1', 'doc1');
      expect(storage.stat).not.toHaveBeenCalled();
    });

    it('409s if nothing was uploaded yet', async () => {
      storage.stat.mockResolvedValue(null);
      const err: any = await svc.completeUpload('s1', 'doc1').catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('UPLOAD_NOT_FOUND');
    });

    it.each([
      ['oversized', { size: 9 * 1024 * 1024, contentType: 'image/jpeg' }],
      ['empty', { size: 0, contentType: 'image/jpeg' }],
      ['a different type than declared', { size: 2000, contentType: 'application/x-msdownload' }],
    ])('deletes a file that is %s', async (_n, stored) => {
      storage.stat.mockResolvedValue(stored);
      const err: any = await svc.completeUpload('s1', 'doc1').catch((e) => e);
      expect(err.getResponse().code).toBe('FILE_NOT_ACCEPTED');
      expect(storage.remove).toHaveBeenCalledWith('partners/p1/doc1.jpg');
      expect(prisma.partnerDocument.delete).toHaveBeenCalled();
    });

    it("404s for someone else's document", async () => {
      prisma.partnerDocument.findFirst.mockResolvedValue(null);
      await expect(svc.completeUpload('s1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.partnerDocument.findFirst).toHaveBeenCalledWith({ where: { id: 'nope', partnerId: 'p1' } });
    });
  });

  describe('list and verification', () => {
    const ok = (type: string, extra: any = {}) => doc({ type, status: 'APPROVED', ...extra });

    it('never returns storage paths', async () => {
      prisma.partnerDocument.findMany.mockResolvedValue([doc({ status: 'PENDING' })]);
      const { items }: any = await svc.list('s1');
      expect(items[0]).not.toHaveProperty('storagePath');
    });

    it('a motorcycle partner needs five approved documents', async () => {
      prisma.partnerDocument.findMany.mockResolvedValue([ok('ID_CARD'), ok('PROFILE_PHOTO')]);
      const { verification }: any = await svc.list('s1');
      expect(verification.status).toBe('INCOMPLETE');
      expect(verification.missing).toEqual(['DRIVERS_LICENSE', 'VEHICLE_REGISTRATION', 'INSURANCE']);
    });

    it('a walking partner needs only ID and photo', async () => {
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ ...profile, type: 'WALKING' });
      prisma.partnerDocument.findMany.mockResolvedValue([ok('ID_CARD'), ok('PROFILE_PHOTO')]);
      expect(((await svc.list('s1')) as any).verification.status).toBe('VERIFIED');
    });

    it('an expired approved document no longer counts, and soon-to-expire ones are flagged', async () => {
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ ...profile, type: 'WALKING' });
      prisma.partnerDocument.findMany.mockResolvedValue([ok('ID_CARD', { expiresAt: new Date(Date.now() - 1000) }), ok('PROFILE_PHOTO', { expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000) })]);
      const { verification }: any = await svc.list('s1');
      expect(verification.missing).toEqual(['ID_CARD']);
      expect(verification.expiringSoon).toEqual(['PROFILE_PHOTO']);
    });
  });

  describe('remove', () => {
    it('deletes the file and the record, but not an approved document', async () => {
      await expect(svc.remove('s1', 'doc1')).resolves.toEqual({ removed: true });
      expect(storage.remove).toHaveBeenCalledWith('partners/p1/doc1.jpg');
      prisma.partnerDocument.findFirst.mockResolvedValue(doc({ status: 'APPROVED' }));
      const err: any = await svc.remove('s1', 'doc1').catch((e) => e);
      expect(err.getResponse().code).toBe('DOCUMENT_APPROVED');
    });
  });

  describe('assertCanWork', () => {
    it('lets everyone through while the requirement is off, and admins always', async () => {
      await expect(svc.assertCanWork('s1', 'DELIVERY_PARTNER')).resolves.toBeUndefined();
      settings['documents.requireVerification'] = true;
      await expect(svc.assertCanWork('a1', 'ADMIN')).resolves.toBeUndefined();
    });

    it('blocks an unverified partner with NOT_VERIFIED when it is on', async () => {
      settings['documents.requireVerification'] = true;
      const err: any = await svc.assertCanWork('s1', 'DELIVERY_PARTNER').catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: 'NOT_VERIFIED' });
      expect(err.getResponse().missing).toContain('ID_CARD');
    });
  });

  describe('admin', () => {
    const pending = { ...doc({ status: 'PENDING' }), partner: { staffUserId: 's1' } };

    it('hands out a short-lived download link, never for a half-uploaded file', async () => {
      prisma.partnerDocument.findUnique.mockResolvedValue(doc({ status: 'PENDING' }));
      await expect(svc.adminDownloadUrl('doc1')).resolves.toEqual({ url: 'https://s/download?t=1', expiresInSeconds: 60 });
      expect(storage.createSignedDownload).toHaveBeenCalledWith('partners/p1/doc1.jpg', 60);
      prisma.partnerDocument.findUnique.mockResolvedValue(doc({ status: 'UPLOADING' }));
      await expect(svc.adminDownloadUrl('doc1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a rejection needs a reason', async () => {
      const err: any = await svc.adminReview('doc1', 'a1', { status: 'REJECTED' }).catch((e) => e);
      expect(err.getResponse().code).toBe('REJECTION_REASON_REQUIRED');
      expect(prisma.partnerDocument.updateMany).not.toHaveBeenCalled();
    });

    it('approves once, replaces older documents of the same type, and tells the partner', async () => {
      prisma.partnerDocument.findUnique.mockResolvedValue(pending);
      prisma.partnerDocument.findMany.mockResolvedValue([{ id: 'old1', storagePath: 'partners/p1/old1.jpg' }]);
      await svc.adminReview('doc1', 'a1', { status: 'APPROVED' });
      expect(prisma.partnerDocument.updateMany.mock.calls[0][0].where).toEqual({ id: 'doc1', status: 'PENDING' });
      expect(prisma.partnerDocument.updateMany.mock.calls[1][0]).toMatchObject({ where: { id: { in: ['old1'] } }, data: { status: 'SUPERSEDED' } });
      expect(storage.remove).toHaveBeenCalledWith('partners/p1/old1.jpg');
      expect(events.emit).toHaveBeenCalledWith('partner.document.reviewed', expect.objectContaining({ staffUserId: 's1', status: 'APPROVED', documentLabel: 'ID card' }));
    });

    it('rejecting keeps the older approved document and sends the reason', async () => {
      prisma.partnerDocument.findUnique.mockResolvedValue(pending);
      await svc.adminReview('doc1', 'a1', { status: 'REJECTED', rejectionReason: ' Blurry ' });
      expect(prisma.partnerDocument.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.partnerDocument.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED', rejectionReason: 'Blurry', reviewedById: 'a1' });
      expect(events.emit).toHaveBeenCalledWith('partner.document.reviewed', expect.objectContaining({ status: 'REJECTED', reason: 'Blurry' }));
    });

    it('409s when the document is not waiting for review (already reviewed or still uploading)', async () => {
      prisma.partnerDocument.findUnique.mockResolvedValue(pending);
      prisma.partnerDocument.updateMany.mockResolvedValue({ count: 0 });
      const err: any = await svc.adminReview('doc1', 'a1', { status: 'APPROVED' }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('DOCUMENT_NOT_PENDING');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('404s for an unknown document', async () => {
      prisma.partnerDocument.findUnique.mockResolvedValue(null);
      await expect(svc.adminReview('nope', 'a1', { status: 'APPROVED' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
