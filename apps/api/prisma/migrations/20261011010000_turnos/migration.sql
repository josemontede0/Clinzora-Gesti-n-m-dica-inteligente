-- CreateEnum
CREATE TYPE "QueueTicketStatus" AS ENUM ('ESPERANDO', 'LLAMADO', 'ATENDIENDO', 'ATENDIDO', 'NO_SE_PRESENTO', 'CANCELADO');

-- CreateTable
CREATE TABLE "QueueArea" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "autoCheckin" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueTicket" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "status" "QueueTicketStatus" NOT NULL DEFAULT 'ESPERANDO',
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "priorityReason" TEXT,
    "patientId" UUID,
    "appointmentId" UUID,
    "visitorName" TEXT,
    "station" TEXT,
    "calledCount" INTEGER NOT NULL DEFAULT 0,
    "calledAt" TIMESTAMPTZ(3),
    "calledById" UUID,
    "servedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "transferredFromId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QueueTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueCounter" (
    "areaId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QueueCounter_pkey" PRIMARY KEY ("areaId","day")
);

-- CreateTable
CREATE TABLE "DisplayScreen" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "showNames" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisplayScreen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QueueArea_branchId_code_key" ON "QueueArea"("branchId", "code");

-- CreateIndex
CREATE INDEX "QueueTicket_branchId_day_status_idx" ON "QueueTicket"("branchId", "day", "status");

-- CreateIndex
CREATE INDEX "QueueTicket_appointmentId_idx" ON "QueueTicket"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "QueueTicket_areaId_day_number_key" ON "QueueTicket"("areaId", "day", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DisplayScreen_tokenHash_key" ON "DisplayScreen"("tokenHash");

-- AddForeignKey
ALTER TABLE "QueueTicket" ADD CONSTRAINT "QueueTicket_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "QueueArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Datos iniciales de turnos ─────────────

-- Permisos nuevos.
INSERT INTO "Permission" (id, code, module, description) VALUES
  (gen_random_uuid(), 'queue.manage', 'turnos', 'Emitir y llamar turnos de la sala de espera'),
  (gen_random_uuid(), 'queue.configure', 'turnos', 'Configurar áreas de turnos y pantallas de recepción')
ON CONFLICT (code) DO NOTHING;

-- Asignación a los roles iniciales existentes (los roles personalizados se ajustan en Configuración).
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id FROM "Role" r JOIN "Permission" p ON p.code = 'queue.manage'
WHERE r.code IN ('RECEPCION', 'MEDICO', 'ENFERMERIA', 'CAJA', 'GERENCIA')
ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id FROM "Role" r JOIN "Permission" p ON p.code = 'queue.configure'
WHERE r.code IN ('ADMIN', 'GERENCIA')
ON CONFLICT DO NOTHING;

-- Áreas iniciales en cada sucursal existente.
INSERT INTO "QueueArea" (id, "organizationId", "branchId", code, name, "autoCheckin", "sortOrder")
SELECT gen_random_uuid(), b."organizationId", b.id, a.code, a.name, a.auto, a.ord
FROM "Branch" b
CROSS JOIN (VALUES ('C', 'Consulta', true, 1), ('P', 'Caja', false, 2), ('I', 'Información', false, 3)) AS a(code, name, auto, ord)
ON CONFLICT ("branchId", code) DO NOTHING;
