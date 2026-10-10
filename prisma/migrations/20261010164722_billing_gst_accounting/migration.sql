-- AlterTable
ALTER TABLE "guests" ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "gstStateCode" TEXT,
ADD COLUMN     "gstin" TEXT;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "gstRegistered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gstStateCode" TEXT,
ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
ADD COLUMN     "legalName" TEXT;

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "sacCode" TEXT,
    "description" TEXT NOT NULL,
    "treatment" TEXT NOT NULL DEFAULT 'TAXABLE',
    "rateBp" INTEGER NOT NULL DEFAULT 0,
    "cessBp" INTEGER NOT NULL DEFAULT 0,
    "tariffMinMinor" INTEGER,
    "tariffMaxMinor" INTEGER,
    "placeOfSupply" TEXT NOT NULL DEFAULT 'PROPERTY_STATE',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "legalRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" UUID NOT NULL,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folios" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "netMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "balanceDeltaMinor" INTEGER NOT NULL,
    "taxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "taxDetail" JSONB,
    "taxRuleId" UUID,
    "serviceDate" DATE,
    "reversesEntryId" UUID,
    "paymentId" UUID,
    "refundId" UUID,
    "idempotencyKey" TEXT,
    "reason" TEXT,
    "postedBy" UUID NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folio_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "shiftId" UUID,
    "receivedBy" UUID NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "shiftId" UUID,
    "refundedBy" UUID NOT NULL,
    "refundedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "series" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "originalInvoiceId" UUID,
    "supplier" JSONB NOT NULL,
    "recipient" JSONB NOT NULL,
    "placeOfSupply" TEXT,
    "netMinor" INTEGER NOT NULL,
    "cgstMinor" INTEGER NOT NULL DEFAULT 0,
    "sgstMinor" INTEGER NOT NULL DEFAULT 0,
    "igstMinor" INTEGER NOT NULL DEFAULT 0,
    "cessMinor" INTEGER NOT NULL DEFAULT 0,
    "grossMinor" INTEGER NOT NULL,
    "reason" TEXT,
    "issuedBy" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "folioEntryId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "sacCode" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "netMinor" INTEGER NOT NULL,
    "cgstMinor" INTEGER NOT NULL DEFAULT 0,
    "sgstMinor" INTEGER NOT NULL DEFAULT 0,
    "igstMinor" INTEGER NOT NULL DEFAULT 0,
    "cessMinor" INTEGER NOT NULL DEFAULT 0,
    "grossMinor" INTEGER NOT NULL,
    "taxDetail" JSONB,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_shifts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "openedBy" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingMinor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedBy" UUID,
    "closedAt" TIMESTAMP(3),
    "countedMinor" INTEGER,
    "expectedMinor" INTEGER,
    "varianceMinor" INTEGER,
    "totals" JSONB,
    "varianceReason" TEXT,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "propertyId" UUID,
    "date" DATE NOT NULL,
    "memo" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "debitMinor" INTEGER NOT NULL DEFAULT 0,
    "creditMinor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_rules_tenantId_category_status_idx" ON "tax_rules"("tenantId", "category", "status");

-- CreateIndex
CREATE INDEX "folios_tenantId_propertyId_idx" ON "folios"("tenantId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "folios_reservationId_key" ON "folios"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "folio_entries_reversesEntryId_key" ON "folio_entries"("reversesEntryId");

-- CreateIndex
CREATE INDEX "folio_entries_folioId_idx" ON "folio_entries"("folioId");

-- CreateIndex
CREATE UNIQUE INDEX "folio_entries_tenantId_idempotencyKey_key" ON "folio_entries"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_folioId_idx" ON "payments"("folioId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_idempotencyKey_key" ON "payments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "refunds_folioId_idx" ON "refunds"("folioId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_sequences_propertyId_series_financialYear_key" ON "invoice_sequences"("propertyId", "series", "financialYear");

-- CreateIndex
CREATE INDEX "invoices_tenantId_propertyId_issuedAt_idx" ON "invoices"("tenantId", "propertyId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_propertyId_number_key" ON "invoices"("propertyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_folioEntryId_key" ON "invoice_lines"("folioEntryId");

-- CreateIndex
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "cash_shifts_tenantId_propertyId_status_idx" ON "cash_shifts"("tenantId", "propertyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenantId_code_key" ON "accounts"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_sourceType_sourceId_key" ON "journal_entries"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "journal_lines_entryId_idx" ON "journal_lines"("entryId");

-- CreateIndex
CREATE INDEX "journal_lines_tenantId_accountId_idx" ON "journal_lines"("tenantId", "accountId");

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cash_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cash_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_folioEntryId_fkey" FOREIGN KEY ("folioEntryId") REFERENCES "folio_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Billing / GST / accounting guarantees =====

ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK ("amountMinor" > 0);
ALTER TABLE refunds ADD CONSTRAINT refunds_amount_positive CHECK ("amountMinor" > 0);
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_nonneg CHECK ("debitMinor" >= 0 AND "creditMinor" >= 0),
  ADD CONSTRAINT journal_lines_one_side CHECK (("debitMinor" = 0) <> ("creditMinor" = 0));
ALTER TABLE tax_rules
  ADD CONSTRAINT tax_rules_rates CHECK ("rateBp" BETWEEN 0 AND 10000 AND "cessBp" BETWEEN 0 AND 10000),
  ADD CONSTRAINT tax_rules_dates CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- Financial records are append-only.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['folio_entries','payments','refunds','invoices','invoice_lines','journal_entries','journal_lines']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- An approved tax rule's terms can never change; it can only be retired.
CREATE OR REPLACE FUNCTION tax_rule_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'only draft tax rules can be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('APPROVED','RETIRED') THEN
    IF NEW.status NOT IN ('APPROVED','RETIRED')
       OR NEW."rateBp" <> OLD."rateBp" OR NEW."cessBp" <> OLD."cessBp" OR NEW.category <> OLD.category
       OR NEW.treatment <> OLD.treatment OR NEW."effectiveFrom" <> OLD."effectiveFrom"
       OR NEW."tariffMinMinor" IS DISTINCT FROM OLD."tariffMinMinor"
       OR NEW."tariffMaxMinor" IS DISTINCT FROM OLD."tariffMaxMinor"
       OR NEW."placeOfSupply" <> OLD."placeOfSupply" THEN
      RAISE EXCEPTION 'approved tax rules are immutable; create a new version';
    END IF;
    IF OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED' THEN RAISE EXCEPTION 'retired rules cannot be reactivated'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tax_rules_guard BEFORE UPDATE OR DELETE ON tax_rules FOR EACH ROW EXECUTE FUNCTION tax_rule_guard();

-- Every journal entry must balance when the transaction commits.
CREATE OR REPLACE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT COALESCE(SUM("debitMinor"),0), COALESCE(SUM("creditMinor"),0) INTO d, c
    FROM journal_lines WHERE "entryId" = NEW."entryId";
  IF d <> c THEN RAISE EXCEPTION 'journal entry % is unbalanced (debit %, credit %)', NEW."entryId", d, c; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_rules','folios','folio_entries','payments','refunds','invoice_sequences',
    'invoices','invoice_lines','cash_shifts','accounts','journal_entries','journal_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
