"""Cookies opcionais para o yt-dlp (contorna "Sign in to confirm you're not a bot").

Se YOUTUBE_COOKIES_FILE apontar para um arquivo existente (formato Netscape),
toda instância de yt_dlp.YoutubeDL criada neste processo passa a usá-lo, a menos
que o código já defina `cookiefile`. Assim cobrimos todos os pontos de download
sem mexer em cada um. O yt-dlp reescreve o arquivo ao fechar, então ele precisa
estar em uma pasta com permissão de escrita.
"""

import logging
import os

logger = logging.getLogger(__name__)

_installed = False


def install() -> bool:
    global _installed
    if _installed:
        return True
    path = os.getenv("YOUTUBE_COOKIES_FILE", "").strip()
    if not path:
        return False
    if not os.path.isfile(path):
        logger.warning("YOUTUBE_COOKIES_FILE não encontrado: %s", path)
        return False
    try:
        import yt_dlp
    except ImportError:
        return False

    original_init = yt_dlp.YoutubeDL.__init__

    def init_with_cookies(self, params=None, auto_init=True):
        merged = dict(params or {})
        merged.setdefault("cookiefile", path)
        original_init(self, merged, auto_init)

    yt_dlp.YoutubeDL.__init__ = init_with_cookies
    _installed = True
    logger.info("yt-dlp usará cookies de %s", path)
    return True
