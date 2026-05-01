from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    GOOGLE_CLIENT_ID: str = ""
    GROQ_API_KEY: str = ""
    GROQ_MODEL: str = "whisper-large-v3-turbo"

    JWT_SECRET: str = ""
    JWT_EXPIRE_DAYS: int = 30

    DB_PATH: str = str(BASE_DIR / "transcribe.db")
    TMP_AUDIO_DIR: str = str(BASE_DIR / "tmp_audio")
    AUDIO_URL_TTL_SECONDS: int = 3600
    AUDIO_RETENTION_HOURS: int = 24

    ALLOWED_ORIGINS: str = "chrome-extension://*"
    HOST: str = "0.0.0.0"
    PORT: int = 8765


settings = Settings()
Path(settings.TMP_AUDIO_DIR).mkdir(parents=True, exist_ok=True)
