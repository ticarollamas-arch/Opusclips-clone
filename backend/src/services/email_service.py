from __future__ import annotations

import asyncio
import logging
import os
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Optional

import boto3

from ..config import Config
from ..database import get_session_maker
from ..models import EmailDelivery

logger = logging.getLogger(__name__)

TRANSACTIONAL = "transactional"
# Product announcements must honour the opt-out: send them only through
# ProductUpdateEmailService, which checks it and adds the unsubscribe headers.
PRODUCT_UPDATE = "product_update"


@dataclass(frozen=True)
class EmailContent:
    subject: str
    html: str
    text: str
    headers: tuple[tuple[str, str], ...] = ()
    category: str = TRANSACTIONAL
    reply_to: tuple[str, ...] = ()


class SesEmailService:
    def __init__(self, config: Optional[Config] = None):
        self.config = config or Config()
        self.region = self.config.aws_region
        self.access_key_id = self.config.aws_access_key_id
        self.secret_access_key = self.config.aws_secret_access_key
        self.from_email = self.config.ses_from_email
        self._client = None
        # Own mailbox over SMTP (e.g. the domain's hosting), so no paid email API is needed.
        self.smtp_host = (os.getenv("SMTP_HOST") or "").strip()
        self.smtp_port = int(os.getenv("SMTP_PORT", "465"))
        self.smtp_user = (os.getenv("SMTP_USER") or "").strip()
        self.smtp_password = os.getenv("SMTP_PASSWORD") or ""
        self.smtp_from = (os.getenv("SMTP_FROM") or self.smtp_user or self.from_email).strip()

    @property
    def uses_smtp(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)

    @property
    def is_configured(self) -> bool:
        if self.uses_smtp:
            return True
        return bool(
            self.region
            and self.access_key_id
            and self.secret_access_key
            and self.from_email
        )

    def _send_smtp(self, recipient: str, content: EmailContent) -> dict:
        message = EmailMessage()
        message_id = make_msgid(domain=self.smtp_from.rsplit("@", 1)[-1].strip(">") or None)
        message["Message-ID"] = message_id
        message["From"] = self.smtp_from
        message["To"] = recipient
        message["Subject"] = content.subject
        if content.reply_to:
            message["Reply-To"] = ", ".join(content.reply_to)
        for name, value in content.headers:
            message[name] = value
        message.set_content(content.text)
        message.add_alternative(content.html, subtype="html")
        context = ssl.create_default_context()
        if self.smtp_port == 465:
            server: smtplib.SMTP = smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, context=context, timeout=30)
        else:
            server = smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=30)
            server.starttls(context=context)
        with server:
            if self.smtp_user:
                server.login(self.smtp_user, self.smtp_password)
            server.send_message(message)
        return {"MessageId": message_id.strip("<>")}

    def _send(self, recipient: str, content: EmailContent) -> dict:
        headers = [{"Name": name, "Value": value} for name, value in content.headers]
        # boto3 clients are thread-safe; reuse one across a campaign's sends.
        if self._client is None:
            self._client = boto3.client(
                "sesv2",
                region_name=self.region,
                aws_access_key_id=self.access_key_id,
                aws_secret_access_key=self.secret_access_key,
            )
        return self._client.send_email(
            FromEmailAddress=self.from_email,
            Destination={"ToAddresses": [recipient]},
            **({"ReplyToAddresses": list(content.reply_to)} if content.reply_to else {}),
            Content={
                "Simple": {
                    **({"Headers": headers} if headers else {}),
                    "Subject": {"Data": content.subject, "Charset": "UTF-8"},
                    "Body": {
                        "Html": {"Data": content.html, "Charset": "UTF-8"},
                        "Text": {"Data": content.text, "Charset": "UTF-8"},
                    },
                }
            },
        )

    async def send_email(self, recipient: str, content: EmailContent) -> dict:
        if not self.is_configured:
            raise RuntimeError(
                "Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD and "
                "SMTP_FROM (own mailbox), or the Amazon SES variables."
            )
        if content.category == PRODUCT_UPDATE and not any(
            name.lower() == "list-unsubscribe-post" for name, _ in content.headers
        ):
            raise ValueError("Send product updates through ProductUpdateEmailService")

        sender = self._send_smtp if self.uses_smtp else self._send
        response = await asyncio.to_thread(sender, recipient, content)
        # This is acceptance by SES, not proof of inbox delivery. Record only
        # metadata: bodies can contain password reset or verification tokens.
        message_id = response["MessageId"]
        try:
            async with get_session_maker()() as db:
                db.add(EmailDelivery(
                    message_id=message_id,
                    recipient=recipient,
                    subject=content.subject,
                    region="smtp" if self.uses_smtp else self.region,
                ))
                await db.commit()
        except Exception:
            # SES has already accepted the message. Preserve a correlation
            # fallback without making callers retry and send duplicate emails.
            logger.exception(
                "SES audit persistence failed: message_id=%s recipient=%s region=%s subject=%r",
                message_id, recipient, self.region, content.subject,
            )
        return dict(response)


def first_name_for(
    *,
    first_name: Optional[str] = None,
    full_name: Optional[str] = None,
    default: str = "there",
) -> str:
    if first_name and first_name.strip():
        return first_name.strip()
    if full_name and full_name.strip():
        return full_name.strip().split()[0]
    return default
