-- Usernames, optional email, phone numbers, sign-up verification codes

-- New one-time code types (not used inside this migration, so safe in one transaction on PG 12+)
ALTER TYPE "AuthTokenType" ADD VALUE 'SIGNUP_VERIFY';
ALTER TYPE "AuthTokenType" ADD VALUE 'PHONE_CHANGE';

-- Where a code was sent ("email" or "sms")
ALTER TABLE "AuthToken" ADD COLUMN "channel" TEXT;

-- Users: username (filled below), optional email, phone
ALTER TABLE "User" ADD COLUMN "username" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN "pendingPhone" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- Give every existing account a username from its email (before the @), made unique with a number
WITH base AS (
  SELECT
    id,
    "createdAt",
    COALESCE(NULLIF(left(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._]', '', 'g'), 26), ''), 'user') AS b
  FROM "User"
),
ranked AS (
  SELECT id, b, row_number() OVER (PARTITION BY b ORDER BY "createdAt") AS n FROM base
)
UPDATE "User" u
SET username = CASE WHEN r.n = 1 THEN r.b ELSE r.b || r.n END
FROM ranked r
WHERE u.id = r.id;

-- Usernames must start with a letter and be at least 3 characters
UPDATE "User" SET username = 'user_' || username WHERE username !~ '^[a-z][a-z0-9._]{2,}$';

-- Default keeps older app versions (which don't send a username) working during the rollout
ALTER TABLE "User" ALTER COLUMN "username" SET DEFAULT ('user_'::text || substr(md5((random())::text), 1, 10));
ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- Accounts created before verification was required keep working (e.g. the demo account,
-- whose address is not a real inbox). New sign-ups must verify before they can sign in.
UPDATE "User" SET "emailVerifiedAt" = NOW() WHERE "emailVerifiedAt" IS NULL AND email IS NOT NULL;
