import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.DELIVERY_CODE_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error(
      'DELIVERY_CODE_ENCRYPTION_KEY is not configured',
    );
  }

  const key = Buffer.from(secret, 'hex');

  if (key.length !== 32) {
    throw new Error(
      'DELIVERY_CODE_ENCRYPTION_KEY must be 32 bytes (64 hex characters)',
    );
  }

  return key;
}

export function encryptDeliveryCode(
  code: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    ALGORITHM,
    getKey(),
    iv,
  );

  const encrypted = Buffer.concat([
    cipher.update(code, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

export function decryptDeliveryCode(
  encryptedValue: string,
): string {
  const [ivHex, authTagHex, encryptedHex] =
    encryptedValue.split(':');

  if (
    !ivHex ||
    !authTagHex ||
    !encryptedHex
  ) {
    throw new Error(
      'Invalid encrypted delivery code',
    );
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivHex, 'hex'),
  );

  decipher.setAuthTag(
    Buffer.from(authTagHex, 'hex'),
  );

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(encryptedHex, 'hex'),
    ),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
