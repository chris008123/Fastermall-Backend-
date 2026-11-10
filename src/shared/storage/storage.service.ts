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

  async createSignedDownload(path: string, seconds = 60) {
    const { data, error } = await this.storage().createSignedUrl(path, seconds);
    if (error || !data) this.unavailable('download URL', error);
    return data.signedUrl;
  }
}
