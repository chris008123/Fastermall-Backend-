import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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
}
