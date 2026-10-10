-- Búsqueda de pacientes sin distinguir tildes ni mayúsculas ("martinez" encuentra "Martínez").
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() no es IMMUTABLE; este envoltorio sí lo es y permite indexar.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

DROP INDEX IF EXISTS "Patient_search_name_idx";
CREATE INDEX "Patient_search_name_idx" ON "Patient" ("organizationId", lower(f_unaccent("firstName" || ' ' || "lastName")));
