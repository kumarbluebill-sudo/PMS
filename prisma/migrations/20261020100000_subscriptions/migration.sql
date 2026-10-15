-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "monthlyPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "annualPriceMinor" INTEGER,
    "annualDiscountBps" INTEGER NOT NULL DEFAULT 1667,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "customPricing" BOOLEAN NOT NULL DEFAULT false,
    "maxProperties" INTEGER,
    "maxRooms" INTEGER,
    "maxUsers" INTEGER,
    "maxStorageMb" INTEGER,
    "maxIntegrations" INTEGER,
    "features" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_addons" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "monthlyPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "redeemed" INTEGER NOT NULL DEFAULT 0,
    "planCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "interval" TEXT NOT NULL DEFAULT 'MONTHLY',
    "status" TEXT NOT NULL DEFAULT 'TRIAL',
    "trialEndsAt" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "graceEndsAt" TIMESTAMP(3),
    "couponId" UUID,
    "couponMonthsLeft" INTEGER NOT NULL DEFAULT 0,
    "priceOverrideMinor" INTEGER,
    "pendingPlanId" UUID,
    "pendingInterval" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lines" JSONB NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "taxBps" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "grossMinor" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
    "idempotencyKey" TEXT NOT NULL,
    "recordedBy" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform_counters" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_counters_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CONTACT',
    "name" TEXT NOT NULL,
    "hotel" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "rooms" INTEGER,
    "properties" INTEGER,
    "integrations" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plan_addons_code_key" ON "plan_addons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "subscriptions"("tenantId");

-- CreateIndex
CREATE INDEX "subscriptions_status_periodEnd_idx" ON "subscriptions"("status", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_number_key" ON "subscription_invoices"("number");

-- CreateIndex
CREATE INDEX "subscription_invoices_tenantId_status_idx" ON "subscription_invoices"("tenantId", "status");

-- CreateIndex
CREATE INDEX "subscription_invoices_subscriptionId_idx" ON "subscription_invoices"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_idempotencyKey_key" ON "subscription_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "subscription_payments_tenantId_idx" ON "subscription_payments"("tenantId");

-- CreateIndex
CREATE INDEX "subscription_payments_invoiceId_idx" ON "subscription_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "subscription_events_tenantId_createdAt_idx" ON "subscription_events"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "leads_createdAt_idx" ON "leads"("createdAt");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- Provider-wide tables (plans, add-ons, coupons, settings, counters, leads) have no tenant column: the runtime role may
-- use them, and writes are made only by code behind the platform-administrator check.
-- Per-hotel subscription tables are isolated by tenant like every other tenant table, plus a second policy that opens
-- them to platform code only, through the transaction setting app.platform, which only the platform helper sets.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans','plan_addons','coupons','platform_settings','platform_counters','leads']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
      EXECUTE format('CREATE POLICY app_role_access ON %I FOR ALL TO pms_app USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['subscriptions','subscription_invoices','subscription_payments','subscription_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_access ON %I
      USING (current_setting('app.platform', true) = 'on')
      WITH CHECK (current_setting('app.platform', true) = 'on')$p$, t);
  END LOOP;
END $$;

-- Money and state checks.
ALTER TABLE "plans" ADD CONSTRAINT "plans_price_check" CHECK ("monthlyPriceMinor" >= 0 AND ("annualPriceMinor" IS NULL OR "annualPriceMinor" >= 0) AND "annualDiscountBps" BETWEEN 0 AND 10000);
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_kind_check" CHECK ("kind" IN ('PERCENT','AMOUNT') AND "value" > 0 AND ("kind" <> 'PERCENT' OR "value" <= 10000) AND "months" >= 1);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_status_check" CHECK ("status" IN ('TRIAL','ACTIVE','PAYMENT_DUE','PAST_DUE','SUSPENDED','CANCELLED','EXPIRED') AND "interval" IN ('MONTHLY','ANNUAL'));
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_check" CHECK ("status" IN ('OPEN','PAID','VOID') AND "kind" IN ('NEW','RENEWAL','UPGRADE') AND "grossMinor" >= 0 AND "netMinor" >= 0);
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_check" CHECK ("amountMinor" > 0 AND "status" IN ('SUCCEEDED','FAILED'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON plans, plan_addons, coupons, platform_settings, platform_counters, leads TO pms_app;
    GRANT SELECT, INSERT, UPDATE ON subscriptions, subscription_invoices, subscription_payments TO pms_app;
    GRANT SELECT, INSERT ON subscription_events TO pms_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Starting plans. These are ordinary rows: the platform administrator edits prices, limits and features.
-- ---------------------------------------------------------------------------
INSERT INTO "plans" ("id","code","name","description","active","isPublic","sortOrder","monthlyPriceMinor","annualPriceMinor","annualDiscountBps","currency","trialDays","customPricing","maxProperties","maxRooms","maxUsers","maxStorageMb","maxIntegrations","features","createdAt","updatedAt") VALUES
  (gen_random_uuid(), 'starter', 'Starter', 'For a small hotel or guest house running one property.', true, true, 1, 99900, NULL, 1667, 'INR', 14, false, 1, 15, 3, NULL, 0, '{"reservations":true,"front_desk":true,"housekeeping":true,"billing_gst":true,"reports_basic":true,"email_confirmations":true,"whatsapp":false,"reports_advanced":false,"rate_plans":false,"multi_property":false,"channel_manager":false,"data_export":true,"custom_roles":false,"priority_support":false,"integrations":false,"dedicated_support":false}'::jsonb, now(), now()),
  (gen_random_uuid(), 'professional', 'Professional', 'For a growing hotel that needs reports, rate plans and guest messaging.', true, true, 2, 249900, NULL, 1667, 'INR', 14, false, 1, 50, 10, NULL, 2, '{"reservations":true,"front_desk":true,"housekeeping":true,"billing_gst":true,"reports_basic":true,"email_confirmations":true,"whatsapp":true,"reports_advanced":true,"rate_plans":true,"multi_property":false,"channel_manager":false,"data_export":true,"custom_roles":true,"priority_support":false,"integrations":false,"dedicated_support":false}'::jsonb, now(), now()),
  (gen_random_uuid(), 'growth', 'Growth', 'For small groups with several properties and channel connections.', true, true, 3, 499900, NULL, 1667, 'INR', 14, false, 3, 150, 30, NULL, 5, '{"reservations":true,"front_desk":true,"housekeeping":true,"billing_gst":true,"reports_basic":true,"email_confirmations":true,"whatsapp":true,"reports_advanced":true,"rate_plans":true,"multi_property":true,"channel_manager":true,"data_export":true,"custom_roles":true,"priority_support":true,"integrations":true,"dedicated_support":false}'::jsonb, now(), now()),
  (gen_random_uuid(), 'enterprise', 'Enterprise', 'For hotel groups. Priced to your needs; talk to sales.', true, true, 4, 999900, NULL, 1667, 'INR', 14, true, NULL, NULL, NULL, NULL, NULL, '{"reservations":true,"front_desk":true,"housekeeping":true,"billing_gst":true,"reports_basic":true,"email_confirmations":true,"whatsapp":true,"reports_advanced":true,"rate_plans":true,"multi_property":true,"channel_manager":true,"data_export":true,"custom_roles":true,"priority_support":true,"integrations":true,"dedicated_support":true}'::jsonb, now(), now());

INSERT INTO "platform_settings" ("key","value","updatedAt") VALUES
  ('saas.legalName', '"MK Solutions"', now()),
  ('saas.gstin', '""', now()),
  ('saas.address', '""', now()),
  ('saas.stateCode', '""', now()),
  ('saas.gstBps', '1800', now()),
  ('saas.invoicePrefix', '"MKS"', now()),
  ('saas.paymentInstructions', '"Pay by bank transfer or UPI to the account shown here, quoting the invoice number. Your plan is renewed once the payment is recorded."', now()),
  ('saas.salesEmail', '""', now()),
  ('saas.defaultTrialDays', '14', now()),
  ('saas.graceDays', '7', now()),
  ('saas.renewalLeadDays', '7', now()),
  ('saas.expireAfterSuspendedDays', '60', now()),
  ('saas.pastDueReadOnly', 'false', now());

-- Hotels that already use the system keep full access: an active Enterprise subscription with no price and no end date.
INSERT INTO "subscriptions" ("id","tenantId","planId","interval","status","periodStart","priceOverrideMinor","note","createdAt","updatedAt")
SELECT gen_random_uuid(), t."id", (SELECT "id" FROM "plans" WHERE "code" = 'enterprise'), 'ANNUAL', 'ACTIVE', now(), 0, 'Founding customer: existing hotel, no charge and no limits', now(), now()
FROM "tenants" t;
