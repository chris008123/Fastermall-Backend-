-- The partner-app branch stored ticket replies in "support_messages"; the
-- main branch in "support_ticket_replies". They are merged into the latter,
-- which now also records replies written by the ticket's owner.

-- AlterTable
ALTER TABLE "support_ticket_replies" ADD COLUMN IF NOT EXISTS "fromAdmin" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "authorId" TEXT;

-- Copy any partner-app replies across. An admin author is kept as
-- staffUserId only if that staff account still exists (foreign key).
INSERT INTO "support_ticket_replies" ("id", "ticketId", "staffUserId", "fromAdmin", "authorId", "message", "createdAt")
SELECT m."id",
       m."ticketId",
       CASE WHEN m."fromAdmin" AND EXISTS (SELECT 1 FROM "staff_users" s WHERE s."id" = m."authorId") THEN m."authorId" END,
       m."fromAdmin",
       m."authorId",
       m."body",
       m."createdAt"
FROM "support_messages" m
ON CONFLICT ("id") DO NOTHING;

-- DropTable
DROP TABLE "support_messages";
