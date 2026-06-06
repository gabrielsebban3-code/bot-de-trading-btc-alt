FROM python:3.11-slim

# Évite les fichiers .pyc et force un flush immédiat des logs (utile pour fly logs)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Installer les dépendances en premier (cache de build)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copier le code
COPY . .

# Lancer le bot (worker continu, pas de service HTTP)
CMD ["python", "main.py"]
