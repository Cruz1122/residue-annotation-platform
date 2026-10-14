from __future__ import annotations

from dataclasses import dataclass
from html import escape
from urllib.parse import urlencode

import resend

from app.core.config import Settings


class EmailDeliveryError(RuntimeError):
    """A sanitized email-provider failure safe to handle at the API boundary."""


@dataclass(frozen=True, slots=True)
class AuthEmail:
    subject: str
    text: str
    html: str


def _action_url(settings: Settings, path: str, token: str) -> str:
    base_url = settings.frontend_base_url.rstrip("/")
    # Keep the one-time secret in the URL fragment. Fragments are available to
    # the browser but are not sent to the frontend server or included in its
    # access logs.
    return f"{base_url}{path}#{urlencode({'token': token})}"


def _template(
    *, title: str, introduction: str, action_label: str, action_url: str, expiry: str
) -> str:
    safe_title = escape(title)
    safe_introduction = escape(introduction)
    safe_label = escape(action_label)
    safe_url = escape(action_url, quote=True)
    safe_expiry = escape(expiry)
    return f"""<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{safe_title}</title>
  </head>
  <body style="margin:0;background:#f3f4f4;color:#111318;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
      style="background:#f3f4f4;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
            style="max-width:520px;background:#ffffff;border:1px solid #a9acb0;">
            <tr>
              <td style="padding:28px 30px;border-bottom:1px solid #cfd1d3;">
                <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;
                  color:#2f8050;text-transform:uppercase;">Residue Annotation Platform</div>
                <h1 style="margin:18px 0 0;font-size:30px;line-height:1.1;
                  letter-spacing:-1px;">{safe_title}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:30px;">
                <p style="margin:0 0 22px;color:#555b64;font-size:15px;line-height:1.6;">
                  {safe_introduction}</p>
                <a href="{safe_url}" style="display:inline-block;background:#111318;
                  border:2px solid #111318;color:#ffffff;text-decoration:none;
                  font-size:13px;font-weight:700;padding:13px 18px;">{safe_label}</a>
                <p style="margin:22px 0 0;color:#747a83;font-size:12px;line-height:1.6;">
                  {safe_expiry} Si no solicitaste esta acción, puedes ignorar este correo.</p>
                <p style="margin:18px 0 0;color:#747a83;font-size:11px;line-height:1.5;
                  word-break:break-all;">Si el botón no funciona, abre este enlace:<br>
                  <a href="{safe_url}" style="color:#2f8050;">{safe_url}</a></p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""


def verification_email(settings: Settings, token: str) -> AuthEmail:
    action_url = _action_url(settings, "/auth/verify-email/", token)
    return AuthEmail(
        subject="Verifica tu correo · Residue Annotation",
        text=(
            "Verifica tu correo para activar tu cuenta de Residue Annotation Platform.\n\n"
            f"Abre este enlace: {action_url}\n\n"
            f"El enlace vence en {settings.auth_verification_token_hours} horas. "
            "Si no creaste esta cuenta, ignora este correo."
        ),
        html=_template(
            title="Verifica tu correo",
            introduction="Activa tu cuenta para acceder a tus proteínas, corridas y resultados.",
            action_label="Verificar correo",
            action_url=action_url,
            expiry=f"El enlace vence en {settings.auth_verification_token_hours} horas.",
        ),
    )


def password_reset_email(settings: Settings, token: str) -> AuthEmail:
    action_url = _action_url(settings, "/auth/reset-password/", token)
    return AuthEmail(
        subject="Restablece tu contraseña · Residue Annotation",
        text=(
            "Recibimos una solicitud para cambiar tu contraseña de Residue Annotation Platform.\n\n"
            f"Abre este enlace: {action_url}\n\n"
            f"El enlace vence en {settings.auth_reset_token_minutes} minutos y solo puede "
            "usarse una vez. "
            "Si no solicitaste el cambio, ignora este correo."
        ),
        html=_template(
            title="Nueva contraseña",
            introduction="Usa este enlace de un solo uso para establecer una contraseña nueva.",
            action_label="Cambiar contraseña",
            action_url=action_url,
            expiry=f"El enlace vence en {settings.auth_reset_token_minutes} minutos.",
        ),
    )


def send_auth_email(settings: Settings, recipient: str, message: AuthEmail) -> str | None:
    if settings.email_provider == "disabled":
        return None
    if settings.email_provider != "resend" or not settings.resend_api_key:
        raise EmailDeliveryError("email delivery is not configured")

    resend.api_key = settings.resend_api_key
    params: resend.Emails.SendParams = {
        "from": settings.email_from,
        "to": [recipient],
        "subject": message.subject,
        "text": message.text,
        "html": message.html,
        "tags": [{"name": "category", "value": "account_security"}],
    }
    try:
        response = resend.Emails.send(params)
    except Exception as exc:
        raise EmailDeliveryError("email provider rejected the request") from exc
    message_id = response.get("id") if isinstance(response, dict) else getattr(response, "id", None)
    if not isinstance(message_id, str) or not message_id:
        raise EmailDeliveryError("email provider returned an invalid response")
    return message_id


def send_verification_email(settings: Settings, recipient: str, token: str) -> str | None:
    return send_auth_email(settings, recipient, verification_email(settings, token))


def send_password_reset_email(settings: Settings, recipient: str, token: str) -> str | None:
    return send_auth_email(settings, recipient, password_reset_email(settings, token))
