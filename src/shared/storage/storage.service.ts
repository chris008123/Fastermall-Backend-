import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface StoredFileInfo {
  size: number;
  contentType: string;
}

/**
 * Private file storage on Supabase (service-role key, server side only).
 * Files go straight from the phone to storage through a short-lived signed
 * upload URL, so they never pass through this server.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client?: SupabaseClient;

  constructor(private readonly config: ConfigService) {}

  get bucket() {
    return this.config.get<string>('documents.bucket') ?? 'partner-documents';
  }

  private storage() {
    if (!this.client) {
      const url = this.config.get<string>('supabase.url');
      const key = this.config.get<string>('supabase.serviceRoleKey');
      if (!url || !key) {
        throw new ServiceUnavailableException({
          message: 'File storage is not set up yet',
          code: 'STORAGE_NOT_CONFIGURED',
        });
      }
      this.client = createClient(url, key, { auth: { persistSession: false } });
    }
    return this.client.storage.from(this.bucket);
  }

  private unavailable(what: string, error: unknown): never {
    this.logger.error(`Storage ${what} failed: ${(error as Error)?.message ?? error}`);
    throw new ServiceUnavailableException({
      message: 'File storage is not available right now. Try again shortly.',
      code: 'STORAGE_UNAVAILABLE',
    });
  }

  /** A one-time URL (and token) the phone uploads to. Valid about 2 hours. */
  async createSignedUpload(path: string) {
    const { data, error } = await this.storage().createSignedUploadUrl(path);
    if (error || !data) this.unavailable('upload URL', error);
    return { signedUrl: data.signedUrl, token: data.token, path: data.path ?? path };
  }

  /** Size and type of what was really uploaded, or null if nothing is there. */
  async stat(path: string): Promise<StoredFileInfo | null> {
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash);
    const name = path.slice(slash + 1);
    const { data, error } = await this.storage().list(folder, { search: name, limit: 5 });
    if (error) this.unavailable('lookup', error);
    const file = (data ?? []).find((f: any) => f.name === name);
    if (!file) return null;
    const meta: any = (file as any).metadata ?? {};
    return { size: Number(meta.size ?? 0), contentType: String(meta.mimetype ?? '') };
  }

  /** Best effort: never throws. */
  async remove(path: string) {
    try {
      await this.storage().remove([path]);
    } catch (error) {
      this.logger.warn(`Could not remove ${path}: ${(error as Error).message}`);
    }
  }

  // ───────── Public buckets (e.g. product images) ─────────

  private readonly readyBuckets = new Set<string>();

  private client$() {
    this.storage(); // creates the client, or throws STORAGE_NOT_CONFIGURED
    return this.client!;
  }

  /**
   * Makes sure a PUBLIC bucket exists, creating it the first time. Files in it
   * are readable by anyone with the URL, so only put things meant to be seen
   * (product photos), never documents.
   */
  private async ensurePublicBucket(bucket: string) {
    if (this.readyBuckets.has(bucket)) return;
    const storage = this.client$().storage;
    const { data } = await storage.getBucket(bucket);
    if (!data) {
      const { error } = await storage.createBucket(bucket, { public: true });
      // "already exists" means another request created it just now.
      if (error && !/exist/i.test(error.message)) this.unavailable('bucket setup', error);
    } else if (!data.public) {
      this.logger.warn(`Bucket ${bucket} is private: its files will not load in the apps`);
    }
    this.readyBuckets.add(bucket);
  }

  /** Uploads a file to a public bucket and returns its permanent URL. */
  async uploadPublic(bucket: string, path: string, body: Buffer, contentType: string) {
    await this.ensurePublicBucket(bucket);
    const files = this.client$().storage.from(bucket);
    const { error } = await files.upload(path, body, { contentType, upsert: false, cacheControl: '31536000' });
    if (error) this.unavailable('upload', error);
    return { path, publicUrl: files.getPublicUrl(path).data.publicUrl };
  }

  // ───────── Private buckets (e.g. customers' reference photos) ─────────

  /** Makes sure a PRIVATE bucket exists (files only reachable by signed link). */
  private async ensurePrivateBucket(bucket: string) {
    if (this.readyBuckets.has(bucket)) return;
    const storage = this.client$().storage;
    const { data } = await storage.getBucket(bucket);
    if (!data) {
      const { error } = await storage.createBucket(bucket, { public: false });
      if (error && !/exist/i.test(error.message)) this.unavailable('bucket setup', error);
    } else if (data.public) {
      this.logger.warn(`Bucket ${bucket} is PUBLIC: customers' private photos in it can be seen by anyone with the link`);
    }
    this.readyBuckets.add(bucket);
  }

  async uploadPrivate(bucket: string, path: string, body: Buffer, contentType: string) {
    await this.ensurePrivateBucket(bucket);
    const { error } = await this.client$().storage.from(bucket).upload(path, body, { contentType, upsert: false });
    if (error) this.unavailable('upload', error);
    return { path };
  }

  /** Short-lived links to private files, in the same order (null if one failed). */
  async signedUrls(bucket: string, paths: string[], seconds = 600): Promise<(string | null)[]> {
    if (paths.length === 0) return [];
    const { data, error } = await this.client$().storage.from(bucket).createSignedUrls(paths, seconds);
    if (error || !data) this.unavailable('download URL', error);
    return paths.map((p) => data.find((d: any) => d.path === p)?.signedUrl ?? null);
  }

  /** Best effort: never throws. */
  async removeFromBucket(bucket: string, paths: string[]) {
    if (paths.length === 0) return;
    try {
      const { error } = await this.client$().storage.from(bucket).remove(paths);
      if (error) throw error;
    } catch (error) {
      this.logger.warn(`Could not remove ${paths.length} file(s) from ${bucket}: ${(error as Error).message}`);
    }
  }

  async createSignedDownload(path: string, seconds = 60) {
    const { data, error } = await this.storage().createSignedUrl(path, seconds);
    if (error || !data) this.unavailable('download URL', error);
    return data.signedUrl;
  }
}
