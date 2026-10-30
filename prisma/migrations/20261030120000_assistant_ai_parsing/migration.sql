ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "speechLanguage" TEXT NOT NULL DEFAULT 'de-DE';
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "aiParsingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "assistantHints" TEXT;

CREATE TABLE IF NOT EXISTS "AssistantUsage" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "userId" UUID,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
  "latencyMs" INTEGER NOT NULL DEFAULT 0,
  "ok" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantUsage_tenantId_createdAt_idx" ON "AssistantUsage"("tenantId", "createdAt");

ALTER TABLE "AssistantUsage"
  ADD CONSTRAINT "AssistantUsage_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
