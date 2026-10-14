# 0016 — Autenticación, sesiones y límite de ejecución por usuario

**Estado:** DRAFT — PENDING ACCEPTANCE — NO APROBADO. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Problema

El scaffold anterior resolvía la identidad de desarrollo con headers locales. Eso no basta para cuentas reales, recuperación de credenciales, sesiones revocables, rate limits ni trazabilidad de acciones. Además, una cuenta no puede reservar más de una proteína en ejecución al mismo tiempo.

## Propuesta

Añadir autenticación propia mínima y versionada en el backend, con passwords derivadas con scrypt, access tokens Bearer de vida corta, refresh tokens opacos rotatorios, tokens de verificación/reset de un solo uso, rate limits persistidos y auditoría sin secretos. Mantener el fallback por headers sólo para `development/test`; producción exige Bearer salvo que una integración de gateway sea aprobada explícitamente.

La regla de concurrencia se define como **máximo una run no terminal por usuario** (`pending`, `running` o `cancel_requested`). El catálogo puede conservar proteínas históricas; la restricción es sobre trabajo simultáneo costoso.

## No objetivos

- No elegir todavía un proveedor institucional SSO/email.
- No afirmar aceptación de producción, threat model, secret scan externo o penetración.
- No almacenar passwords, tokens raw ni secretos HPC en logs o tablas.
