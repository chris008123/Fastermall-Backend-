-- Staff deactivation: existing accounts stay active.
-- AlterTable
-- IF NOT EXISTS: migration 20261031120000_add_staff_sessions (from the other
-- branch) adds isActive too; whichever runs second skips it.
ALTER TABLE "staff_users" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);

-- Staff replies on support tickets.
-- CreateTable
CREATE TABLE "support_ticket_replies" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "staffUserId" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_ticket_replies_ticketId_createdAt_idx" ON "support_ticket_replies"("ticketId", "createdAt");

-- AddForeignKey
ALTER TABLE "support_ticket_replies" ADD CONSTRAINT "support_ticket_replies_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_replies" ADD CONSTRAINT "support_ticket_replies_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
