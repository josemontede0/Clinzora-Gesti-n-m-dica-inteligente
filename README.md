# Clinzora — Gestión médica inteligente

*Tecnología para una mejor salud · Un producto de KonviaRD*

Plataforma para consultorios y centros médicos de República Dominicana. Cubre pacientes, agenda, recepción, expediente clínico, facturación, caja, seguros (ARS), notificaciones, reportes, configuración y auditoría.

> **Estado:** primera versión funcional, verificada con pruebas automáticas, de punta a punta, contra PostgreSQL real (ver [Pruebas](#pruebas)).
> Antes de usarla con pacientes reales hay que completar lo indicado en [Pendientes antes de producción](#pendientes-antes-de-produccion).

---

## Contenido

1. [Arquitectura](#arquitectura)
2. [Requisitos](#requisitos)
3. [Instalación local](#instalacion-local)
4. [Variables de entorno](#variables-de-entorno)
5. [Base de datos y migraciones](#base-de-datos-y-migraciones)
6. [Datos de demostración](#datos-de-demostracion)
7. [Ejecución](#ejecucion)
8. [Pruebas](#pruebas)
9. [Construcción y despliegue](#construccion-y-despliegue)
10. [Notificaciones](#notificaciones)
11. [Pagos con tarjeta](#pagos-con-tarjeta)
12. [Aseguradoras (ARS)](#aseguradoras-ars)
13. [Facturación fiscal (DGII)](#facturacion-fiscal-dgii)
14. [Copias de seguridad y restauración](#copias-de-seguridad-y-restauracion)
15. [Seguridad](#seguridad)
16. [Reglas de negocio clave](#reglas-de-negocio-clave)
17. [Decisiones adoptadas](#decisiones-adoptadas)
18. [Pendientes antes de producción](#pendientes-antes-de-produccion)

---

## Identidad visual

La marca está en `apps/web/public/brand/` (SVG oficiales, sin modificar) y los favicons en `apps/web/src/app/`. El componente `<ClinzoraLogo variant theme height />` (`apps/web/src/components/clinzora-logo.tsx`) elige la variante: horizontal sin slogan en el menú, ícono con el menú contraído y en el encabezado móvil, y vertical en el acceso. Las variantes blancas van sobre fondos oscuros. Los colores (`--cz-navy`, `--cz-teal`, `--cz-blue`, `--cz-gray`, `--cz-bg`, `--cz-gradient`) y la fuente Poppins están en `globals.css`. Los PDF usan el PNG `apps/api/assets/clinzora-logo-horizontal.png`.

## Aplicación instalable (PWA)

Clinzora se instala como app en Android, iPhone/iPad (Safari > Compartir > Agregar a pantalla de inicio), Windows y macOS (botón **Instalar app** en el encabezado o en el login). Incluye manifest con atajos (Agenda, Sala de espera, Pacientes, Caja), íconos y una página sin conexión.

Por privacidad, el service worker (`apps/web/public/sw.js`) **solo guarda archivos estáticos públicos**. Nunca guarda respuestas de la API ni páginas con datos de pacientes: sin conexión se muestra la página "Sin conexión" y no información clínica.

## Recibos de caja

Al registrar un cobro se ofrece **Imprimir** o **Descargar** el recibo en PDF, en ticket de 80 mm (impresora térmica) o en carta. **Caja > Historial de recibos** permite buscar por número, paciente o expediente, con filtros de fecha y estado, y **reimprimir**. Desde la segunda impresión el PDF sale marcado como *REIMPRESIÓN (copia N)*, y cada impresión queda en la auditoría (quién, cuándo, formato). Un pago revertido sale marcado como *REVERTIDO — SIN VALOR*. El recibo incluye el monto en letras e indica que no es un comprobante fiscal.

## Arquitectura

Monorepo con pnpm:

```
apps/
  api/        NestJS 10 + Prisma 6 (PostgreSQL). API REST documentada con Swagger en /docs.
  web/        Next.js 15 (App Router) + React 19 + Tailwind 4 + componentes estilo shadcn/ui.
packages/
  shared/     Contratos compartidos: esquemas Zod v4, permisos, estados, montos en centavos, formatos dominicanos.
infra/
  docker/     Dockerfiles de producción.
  scripts/    Respaldo cifrado y restauración.
```

- **Fuente de verdad:** la API calcula totales, saldos, coberturas, estados y permisos. El frontend solo muestra resultados y previsualizaciones.
- **Validación compartida:** los mismos esquemas Zod validan los formularios (React Hook Form) y cada endpoint (`ZodValidationPipe`). Además se publican en Swagger.
- **Comunicación:** el navegador llama a `/backend/*`, que Next.js reenvía a la API desde el mismo origen. Por eso la cookie de sesión `httpOnly`, `SameSite=Strict` viaja sola y no hace falta CORS.
- **Módulos del backend:** `auth`, `users` (usuarios, roles, auditoría), `settings`, `patients`, `catalog` (especialidades, médicos, horarios, servicios, tarifas), `appointments`, `clinical`, `billing` (cargos, facturas, pagos, caja, fiscal), `insurance` (afiliaciones, autorizaciones, reclamaciones, glosas, pagos de ARS), `notifications`, `reports`, `files`.

### Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript estricto, Tailwind CSS 4, Radix UI (base de shadcn/ui), React Hook Form, Zod, TanStack Table, react-big-calendar, Recharts, sonner |
| Backend | NestJS 10, TypeScript, Prisma 6, Swagger, @nestjs/throttler, helmet, Argon2id (@node-rs/argon2), otplib (TOTP), exceljs, pdfkit, nodemailer |
| Base de datos | PostgreSQL 16 (extensiones `btree_gist` y `unaccent`) |
| Cola de tareas | Tabla `Notification` en PostgreSQL con `FOR UPDATE SKIP LOCKED` (ver [Decisiones](#decisiones-adoptadas)) |

---

## Requisitos

- Node.js 20.11 o superior (probado con 24.20)
- pnpm 11 (`npm i -g pnpm`)
- PostgreSQL 16 con las extensiones `btree_gist` y `unaccent` (incluidas en las distribuciones oficiales)
- Para producción: Docker y Docker Compose, o un servidor con Node.js y un proxy HTTPS (Caddy o Nginx)
- Para respaldos: `pg_dump`, `pg_restore`, `tar` y `openssl`

---

## Instalación local

```bash
pnpm install
cp .env.example apps/api/.env          # complete los secretos (ver abajo)
printf 'API_URL=http://127.0.0.1:3001\n' > apps/web/.env
pnpm build:shared
pnpm db:deploy                          # aplica migraciones
pnpm --filter @medigest/api build && pnpm db:seed   # datos de demostración (opcional)
```

### Base de datos local sin Docker (Windows)

Este repositorio se desarrolló con un clúster propio de PostgreSQL 16 en `infra/pgdata`, en el puerto **5435**. Así no interfiere con otras instalaciones:

```powershell
& 'C:\Program Files\PostgreSQL\16\bin\initdb.exe' -D infra\pgdata -U medigest --auth=scram-sha-256 --pwfile=infra\.dbpass -E UTF8 --locale=C
& 'C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe' start -D infra\pgdata -l infra\pg.log -o "-p 5435"
# crear bases:  medigest  y  medigest_test
```

`infra/.dbpass`, `infra/pgdata` y los `.env` están en `.gitignore`.

---

## Variables de entorno

El archivo `.env.example` está documentado línea por línea. Estas son las principales:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Conexión a PostgreSQL |
| `TEST_DATABASE_URL` | Base **exclusiva** para pruebas e2e: se borra en cada corrida. La API se niega a usarla si coincide con `DATABASE_URL` |
| `SESSION_SECRET`, `FILE_URL_SECRET` | Secretos aleatorios de 32 bytes o más |
| `MFA_ENCRYPTION_KEY` | 64 caracteres hexadecimales (AES-256-GCM para las semillas TOTP) |
| `WEB_ORIGIN` | Origen público del frontend. Se usa para CORS y para verificar `Origin` |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | Expiración por inactividad y absoluta |
| `MFA_ENFORCE` | Exige MFA a los roles marcados. **Siempre activo en producción** |
| `STORAGE_DIR` | Carpeta de archivos privados, fuera de cualquier carpeta pública |
| `NOTIFICATIONS_MODE` | `test` (no envía nada) o `live` |
| `SMTP_*`, `WHATSAPP_*`, `TWILIO_*` | Credenciales de los proveedores |
| `PAYMENTS_PROVIDER` | `test` (terminal de pruebas, **prohibido en producción**) o `none` (POS externo) |
| `LOGIN_RATE_LIMIT` | Intentos de login por minuto y por IP (10 por defecto) |

Generar secretos:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # MFA_ENCRYPTION_KEY
```

---

## Base de datos y migraciones

- Esquema: `apps/api/prisma/schema.prisma`, con unas 60 tablas, relaciones, índices, importes `Decimal(14,2)` y fechas `timestamptz`.
- Migraciones versionadas en `apps/api/prisma/migrations/`:
  - `20261010114359_init`: esquema completo, más SQL propio:
    - **Restricción `EXCLUDE` (btree_gist)**: impide citas solapadas del mismo médico o consultorio aunque dos usuarios reserven al mismo tiempo.
    - Índice único parcial: una sola sesión abierta por caja.
    - `CHECK` de integridad de importes (no negativos, últimos 4 dígitos de tarjeta, etc.).
  - `20261010170000_busqueda_sin_tildes`: extensión `unaccent` e índice para buscar pacientes sin distinguir tildes.
- Aplicar: `pnpm db:deploy` (`prisma migrate deploy`). En desarrollo, `prisma migrate dev` para crear migraciones nuevas.
- **Nunca** modifique a mano la base de producción. Todo cambio va como migración, revisada y probada primero en una copia restaurada.

---

## Datos de demostración

`pnpm db:seed` crea una organización ficticia con:
- 2 sucursales y consultorios;
- 3 médicos con horarios, 4 especialidades y 6 servicios con tarifas;
- la "ARS Demo (ficticia)" con planes y tarifas negociadas;
- 12 pacientes;
- consultas firmadas, facturas, un pago mixto, una reclamación sometida y citas de hoy y de los próximos días;
- usuarios para cada rol.

- **Todo es ficticio:** las cédulas son de la serie `000-` (no corresponden a ningún municipio), los teléfonos `809-555-01XX` y los correos `@ejemplo.test`.
- La contraseña de desarrollo se genera al azar y se guarda en `infra/seed-credentials.txt`, que **no se versiona**. Ahí está la lista de usuarios (`admin@`, `recepcion@`, `medico@`, `medico2@`, `enfermeria@`, `caja@`, `seguros@`, `contabilidad@` y `gerencia@ejemplo.test`).
- `pnpm db:seed -- --reset` borra y vuelve a sembrar. Solo para desarrollo; el seed se niega a correr en producción.
- **Antes de desplegar:** no ejecute el seed. Cree el administrador real y elimine o desactive cualquier cuenta de demostración.

---

## Ejecución

```bash
pnpm dev:api        # API en http://127.0.0.1:3001  (Swagger en /docs)
pnpm dev:web        # Web en http://localhost:3000
```

Las tareas periódicas (cola de notificaciones cada 20 s) arrancan con la API. Se desactivan con `JOBS_ENABLED=false`.

---

## Pruebas

```bash
pnpm test           # unitarias (paquete compartido + backend) — crea y siembra la base de pruebas
pnpm test:e2e       # integración y extremo a extremo contra PostgreSQL (TEST_DATABASE_URL)
pnpm test:ui        # interfaz con Playwright (Chromium), escritorio y móvil, sobre una instancia aislada
pnpm typecheck && pnpm lint
```

**Resultados reales de la última corrida (2026-10-10):**

| Suite | Resultado |
|---|---|
| `packages/shared` (montos, impuestos, cobertura, transiciones, cédula, zonas horarias, política de contraseñas, validaciones) | 12/12 aprobadas |
| `apps/api` unitarias (redacción de logs, enlaces firmados, cifrado MFA, montos de reclamación) | 6/6 aprobadas |
| `apps/api` e2e (45 pruebas en 4 suites) | 45/45 aprobadas |
| `apps/web` interfaz con Playwright (6 flujos en escritorio, 2 en móvil) | 8/8 aprobadas |
| Compilación TypeScript de API y web | Sin errores |
| `next build` (22 rutas) y lint del frontend | Sin errores ni advertencias |
| Respaldo cifrado y restauración en base nueva | Coinciden conteos y montos; una frase incorrecta es rechazada |

Lo que cubren las e2e:
- **Flujo completo** (sección 24 del requerimiento): login, paciente, cita, agenda, llegada, encuentro, signos, notas, firma, cargo automático, factura, pago parcial, pago mixto con tarjeta de prueba, saldo, atención con seguro, reclamación, glosa, pago parcial de la ARS, reportes, auditoría y persistencia tras reiniciar la aplicación.
- **Seguridad:**
  - acceso sin sesión, cookie falsa, CSRF y origen no permitido;
  - acceso sin permiso;
  - el cajero no ve el expediente;
  - un médico sin relación asistencial no ve el expediente, y el intento queda auditado;
  - aislamiento entre organizaciones;
  - entradas maliciosas (inyección SQL, XSS, UUID inválido);
  - bloqueo por intentos fallidos y revocación de sesión;
  - recuperación de contraseña sin revelar cuentas;
  - archivos privados con enlace firmado ligado al usuario;
  - rechazo de ejecutables disfrazados de PDF;
  - errores sin trazas.
- **Pacientes y citas:**
  - búsqueda sin tildes;
  - duplicados por documento y por similitud;
  - fusión;
  - inactivación;
  - solapamiento;
  - **dos reservas simultáneas del mismo espacio** (solo una se confirma);
  - horario, bloqueos, reprogramación, cancelación, transiciones inválidas y lista de espera.
- **Finanzas:**
  - un pago aplicado a varias facturas, con anticipo y aplicación posterior;
  - doble aplicación rechazada;
  - reverso;
  - devolución que conserva la fórmula del saldo;
  - nota de crédito;
  - anulación con reglas;
  - NCF solo con rango registrado;
  - cierre de caja con arqueo.

Lo que cubren las pruebas de interfaz (`apps/web/e2e`):
- Recepción registra un paciente y le agenda una cita en un espacio disponible.
- La búsqueda global encuentra pacientes sin tildes y la médica ve las alergias en el expediente.
- El cajero abre caja y cobra el saldo de una factura, que queda pagada.
- El cajero no puede abrir el expediente clínico.
- Gerencia ve los indicadores financieros separados.
- Sin sesión, la web redirige al inicio de sesión.
- En móvil (Pixel 7): el menú lateral funciona, ninguna pantalla principal desborda horizontalmente y la agenda usa vistas legibles.

Las pruebas de interfaz levantan una API en `:3002` y una web en `:3010` sobre la base de pruebas, que se recrea con `apps/api/scripts/reset-test-db.cjs`. Ese script solo actúa sobre bases cuyo nombre termina en `_test` y que no son la de desarrollo. **Nunca tocan la base de desarrollo.**

**Revisión visual:** se capturaron y revisaron las pantallas principales a 1440 px y a 375 px con varios roles, y se corrigieron los defectos encontrados.

**Lo que no se ha verificado:** las imágenes Docker y los servicios `caddy` y `backup` de Compose no se han ejecutado, porque no hay Docker en el equipo de desarrollo. El YAML se validó con un parser.

---

## Construcción y despliegue

### Docker Compose

```bash
cp .env.docker.example .env.docker      # complete secretos y WEB_ORIGIN
docker compose --env-file .env.docker up -d --build
```

- `db` (PostgreSQL 16), `api` (aplica migraciones al iniciar) y `web` (publicado solo en `127.0.0.1:3000`).
- **HTTPS:** `docker compose --env-file .env.docker --profile https up -d` levanta Caddy con certificados automáticos de Let's Encrypt (`infra/Caddyfile`; cambie el dominio). En una red interna sin dominio público use `tls internal`.
- **Respaldo diario:** el perfil `backup` ejecuta `infra/scripts/backup.sh` a las 02:30 y conserva 30 días. Requiere `BACKUP_PASSPHRASE`.
- No exponga `api` ni `db` a Internet.

### Sin Docker (servidor Linux)

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm db:deploy
NODE_ENV=production node apps/api/dist/src/main.js          # detrás de PM2/systemd
cd apps/web && NODE_ENV=production npx next start -p 3000
```

Hay unidades de systemd de ejemplo (`infra/systemd-medigest-api.service` y `infra/systemd-medigest-web.service`) y una tarea de cron para respaldos (`infra/scripts/medigest-backup.cron`).

Con `NODE_ENV=production`:
- la cookie lleva `Secure`;
- Swagger se desactiva (salvo `SWAGGER_ENABLED=true`);
- MFA es obligatorio para los roles marcados;
- `PAYMENTS_PROVIDER=test` impide arrancar.

Entornos: use bases y `.env` distintos para desarrollo, pruebas y producción. Las pruebas e2e exigen una base propia.

---

## Notificaciones

- **Canales:** correo (SMTP), WhatsApp Business Cloud API (Meta) y SMS (Twilio). Se eligen en Configuración > Parámetros.
- **Tipos:** confirmación, recordatorio (24 h y 2 h por defecto, configurable), cambio, cancelación, pendiente de confirmar y saldo pendiente.
- **Plantillas:** editables, con variables `{{nombre}} {{fecha}} {{hora}} {{medico}} {{ubicacion}} {{centro}} {{monto}}`. No incluyen información clínica.
- **Cola:**
  - reintentos con espera exponencial (máximo 3);
  - **idempotencia** por clave única, para no duplicar mensajes;
  - al reprogramar o cancelar se anulan los recordatorios pendientes;
  - antes de enviar se verifica la vigencia de la cita y el **consentimiento del canal**.
- **Estados:** `ENTREGADO` solo se asigna cuando el proveedor lo confirma por webhook (`/webhooks/whatsapp` con firma `X-Hub-Signature-256` y `/webhooks/sms/status` con firma de Twilio).
- **Modo prueba** (`NOTIFICATIONS_MODE=test`, el estado actual): no sale ningún mensaje. Los correos se escriben en `infra/mail-outbox/` y cada registro queda marcado "Modo prueba".

Para activar los envíos reales:
1. **Correo:** `SMTP_HOST/PORT/USER/PASS/FROM` y `NOTIFICATIONS_MODE=live`.
2. **WhatsApp:**
   - cuenta de WhatsApp Business verificada en Meta, con número y token permanente;
   - `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` y `WHATSAPP_WEBHOOK_VERIFY_TOKEN`;
   - **plantillas aprobadas por Meta** para los mensajes fuera de la ventana de 24 h. El adaptador (`apps/api/src/modules/notifications/channels.ts`) envía hoy mensajes de texto y debe ajustarse a `type: "template"` con los nombres aprobados.
3. **SMS:** `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM` y `PUBLIC_API_URL` para validar la firma del webhook.

---

## Pagos con tarjeta

- El sistema **nunca recibe ni guarda** el número completo de la tarjeta ni el CVV. Solo los últimos 4 dígitos, la marca y el número de aprobación. La base lo refuerza con un `CHECK`.
- Cada intento queda en `PaymentTransaction`, con su estado, el código de respuesta y una clave de idempotencia (un reintento no cobra dos veces). El pago solo se registra si la transacción está `APROBADA`.
- **Modos:**
  - `test`: terminal de pruebas. Aprueba salvo que los últimos 4 dígitos sean `0002` (declinada). Marcado "PRUEBA" y prohibido en producción.
  - `none`: el cobro se hace en un POS externo (CardNet, Azul, etc.) y el cajero registra el número de aprobación del voucher como confirmación verificable.
- **Integración directa:** implemente el contrato de `CardTerminal` (`apps/api/src/modules/billing/card-terminal.ts`) con la API y el sandbox del procesador elegido. Hacen falta credenciales del adquirente.

---

## Aseguradoras (ARS)

- Se gestionan aseguradoras, planes, afiliaciones (titular o dependiente, con vigencia), validaciones de cobertura, autorizaciones, reclamaciones (estados con transiciones controladas, plazos, referencia externa), glosas, pagos recibidos y conciliación.
- **Montos separados:**
  - precio del servicio;
  - total facturado;
  - cobertura estimada y copago del paciente;
  - monto autorizado;
  - reclamado;
  - reconocido (aprobado, o reclamado − glosas);
  - pagado por la ARS;
  - saldo por cobrar.
  Una autorización **no** es un pago.
- **Integración: modo MANUAL.** No se inventan APIs de las ARS. Las validaciones y autorizaciones se registran a mano, con referencia (y evidencia adjunta si se desea), y se marcan como `MANUAL`. Si una ARS ofrece una interfaz autorizada y documentada, se agrega un adaptador sin cambiar el modelo de datos (campo `integrationMode` y método `INTEGRACION`).

---

## Facturación fiscal (DGII)

- **NCF:** el sistema **no genera números propios**. En Configuración > Fiscal se registran los rangos autorizados por la DGII (tipo, desde, hasta, vencimiento), y cada asignación consume el siguiente número de forma atómica.
- **Notas de crédito:** una factura con comprobante emitido no se puede anular; se corrige con nota de crédito.
- **e-CF (serie E):** quedan en estado `PENDIENTE` con el aviso "pendiente de envío". Para emitirlos hace falta un **proveedor de facturación electrónica certificado** o la certificación propia ante la DGII, con firma digital. Nunca se marcan como aceptados sin una respuesta real.
- **Datos de demostración:** el seed incluye un rango B02 de **prueba**, que no es una autorización real.
- **Pendiente de validar con un contador:** los tipos de comprobante que aplican a servicios de salud, el ITBIS (los servicios se configuran exentos por defecto, con tasa editable por servicio) y los formatos 607/608.

---

## Copias de seguridad y restauración

```bash
DATABASE_URL=... BACKUP_PASSPHRASE='frase-larga-guardada-fuera-del-servidor' STORAGE_DIR=infra/storage infra/scripts/backup.sh
DATABASE_URL=<base-nueva-vacía> BACKUP_PASSPHRASE=... STORAGE_DIR=/ruta/restaurada infra/scripts/restore.sh infra/backups/medigest-AAAAMMDD-HHMMSS.tar.enc
```

- **Contenido:** `pg_dump` (formato custom) más los archivos privados, cifrados con AES-256 (`openssl`, pbkdf2, 200 000 iteraciones) y acompañados de un checksum SHA-256.
- **Verificado:** se restauró en una base nueva y coincidieron conteos y montos; la frase incorrecta fue rechazada.
- **Recomendado:**
  - ejecución diaria (cron);
  - copia fuera del servidor;
  - retención según la política legal;
  - **prueba de restauración mensual** en una base aparte.

---

## Seguridad

Implementado:
- **Contraseñas:** Argon2id. Política de 10 o más caracteres con mayúscula, minúscula, número y símbolo. No se pueden repetir las últimas 5.
- **Sesiones:** token opaco aleatorio en cookie `httpOnly` + `SameSite=Strict` (+ `Secure` en producción). En la base solo se guarda su hash. Expiran por inactividad y de forma absoluta, se revocan al cerrar sesión, y cambiar o restablecer la contraseña revoca las demás.
- **Bloqueo** de la cuenta tras N intentos fallidos (configurable) y **rate limiting** global y de login. Una respuesta genérica y de tiempo constante impide descubrir qué usuarios existen.
- **MFA TOTP:** semilla cifrada con AES-256-GCM, obligatoria para los roles marcados en producción.
- **CSRF:** la cabecera `X-Requested-With` es obligatoria en las mutaciones, se verifica `Origin` y la cookie es `SameSite=Strict`.
- **Autorización** en el backend con guards globales y matriz de permisos configurable. Toda consulta filtra por organización, y por sucursal cuando corresponde. Un identificador de otra organización devuelve 404.
- **Expediente clínico:**
  - acceso por relación asistencial (el médico solo ve a sus pacientes; enfermería, a los de sus sucursales; `clinical.read_all` es explícito);
  - cada consulta y cada intento denegado se auditan;
  - las notas firmadas son inmutables y las correcciones quedan versionadas con motivo.
- **Archivos privados:**
  - tipo verificado por los bytes iniciales;
  - descarga solo con sesión y enlace firmado de 5 minutos ligado al usuario;
  - `no-store`;
  - auditada.
- **Auditoría** de operaciones sensibles, sin contraseñas, tokens, tarjetas ni texto clínico.
- **Logs** JSON estructurados con `requestId` y redacción automática de claves sensibles. No se registran cuerpos ni query strings.
- **Errores** sin trazas internas. `helmet` y cabeceras de seguridad en la web.
- **Prisma** usa consultas parametrizadas; el SQL propio usa plantillas parametrizadas.

**Respuesta ante incidentes (mínimo):**
1. Revocar las sesiones afectadas (Configuración > Usuarios > Cerrar sesiones).
2. Rotar `SESSION_SECRET`, `FILE_URL_SECRET` y las credenciales de proveedores.
3. Revisar la auditoría por usuario y fechas.
4. Preservar los logs.
5. Notificar según la Ley 172-13 y a las autoridades que correspondan.
6. Restaurar desde un respaldo verificado si hay alteración de datos.

---

## Reglas de negocio clave

- **Saldo de factura** = monto del paciente − pagos aplicados vigentes − notas de crédito. Lo recalcula siempre el servidor dentro de la transacción.
- **Pago, aplicación y reembolso** son conceptos distintos. Lo no aplicado queda como anticipo. Los pagos no se borran: se revierten con motivo y queda registrada la salida en caja.
- **Devolución desde factura:** reduce la aplicación, emite una nota de crédito por el mismo monto y registra el reembolso. El saldo no cambia y la caja cuadra.
- **Facturado ≠ cobrado:** el panel separa facturado, cobrado neto (descontando reembolsos y reversos) y pendiente (pacientes y ARS).
- **Tarifas con vigencia:** un cambio de precio cierra la tarifa anterior, y las facturas emitidas conservan su precio.
- **Cargo automático** al firmar el encuentro, idempotente por encuentro y servicio.
- **Citas:**
  - transiciones válidas definidas en `packages/shared/src/status.ts`;
  - horario por médico, sucursal y día;
  - bloqueos, vacaciones y feriados;
  - solapamiento impedido por la base de datos.
- **Zona horaria:** las horas se calculan en la zona de la sucursal (por defecto `America/Santo_Domingo`). Fechas en DD/MM/AAAA y moneda DOP (RD$).

---

## Decisiones adoptadas

- **Sin Redis ni BullMQ:** la cola de notificaciones vive en PostgreSQL (`FOR UPDATE SKIP LOCKED`, reintentos, idempotencia). Es segura con varias instancias de la API y evita un servicio extra. Si el volumen lo justifica, puede reemplazarse por BullMQ sin cambiar la interfaz de `NotificationsService`.
- **Validación con Zod compartido** en lugar de clases DTO con class-validator. Así hay un solo origen de reglas para web y API, y Swagger se genera desde los mismos esquemas.
- **"Vencida"** es un estado derivado (vencimiento pasado con saldo), no almacenado.
- **Selects nativos** en formularios por accesibilidad y por la experiencia en móviles. El resto de componentes sigue el patrón de shadcn/ui sobre Radix.
- **Calendario:** react-big-calendar. En móvil la agenda usa las vistas Día y Agenda.
- **Internacionalización:** textos de la navegación en `apps/web/src/lib/i18n.ts`. Las pantallas internas aún tienen textos en línea y habría que extraerlos para traducir.

---

## Pendientes antes de producción

**Requieren credenciales o terceros:**
- WhatsApp Business (Meta), con plantillas aprobadas; SMTP; proveedor de SMS.
- Procesador de tarjetas o terminal integrada (o usar el modo `none` con POS externo).
- Proveedor de e-CF certificado o certificación propia ante la DGII; rangos NCF reales.
- Interfaces autorizadas de las ARS, si existen. Mientras tanto se opera en modo manual.

**Requieren validación jurídica o especializada:**
- Ley 172-13 de protección de datos personales: aviso de privacidad, finalidad, consentimientos, derechos ARCO y transferencia a proveedores (por ejemplo, Meta).
- Normas de expediente clínico y confidencialidad médica (Ley General de Salud 42-01 y reglamentos del MISPAS): contenido mínimo, firma, plazo de conservación (configurable en Parámetros, 10 años por defecto) y procedimiento de eliminación al vencer.
- Obligaciones fiscales: tipos de comprobante, ITBIS en servicios de salud, reportes 606/607/608.
- Política de respaldo y retención, contratos de encargado de tratamiento con proveedores en la nube y plan de respuesta a incidentes.

**Técnicos:**
- Construir y probar las imágenes Docker y los perfiles `https` y `backup` en un equipo con Docker.
- Instalar en el servidor definitivo: dominio y DNS, HTTPS, respaldos programados, monitoreo y rotación de logs.
- **Retención:** existe la revisión (Configuración > Organización > Revisión de retención), que lista los expedientes fuera de plazo. **No se eliminan automáticamente:** la depuración debe definirse con asesoría legal (anonimización, acta, conservación de lo fiscal).
- Extraer el resto de textos al diccionario de i18n (hoy solo está la navegación).
