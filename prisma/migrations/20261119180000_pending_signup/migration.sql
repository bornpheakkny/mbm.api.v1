-- CreateTable
CREATE TABLE "PendingSignup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "channel" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingSignup_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "PendingSignup_tokenHash_key" ON "PendingSignup"("tokenHash");
-- CreateIndex
CREATE INDEX "PendingSignup_username_idx" ON "PendingSignup"("username");
-- CreateIndex
CREATE INDEX "PendingSignup_email_idx" ON "PendingSignup"("email");
-- CreateIndex
CREATE INDEX "PendingSignup_phone_idx" ON "PendingSignup"("phone");
-- CreateIndex
CREATE INDEX "PendingSignup_expiresAt_idx" ON "PendingSignup"("expiresAt");
