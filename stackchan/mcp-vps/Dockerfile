FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖：优先用 gateway 自带 pyproject；没有则装 PyPI 包再挂载源码
COPY gateway/pyproject.toml gateway/README.md* ./
COPY gateway/stackchan_mcp ./stackchan_mcp
COPY gateway/*.toml gateway/*.md ./

RUN pip install --no-cache-dir -U pip \
  && (pip install --no-cache-dir -e ".[tts]" 2>/dev/null \
      || pip install --no-cache-dir -e . 2>/dev/null \
      || pip install --no-cache-dir "stackchan-mcp[tts]" aiohttp mcp httpx) \
  && pip install --no-cache-dir aiohttp mcp httpx opuslib 2>/dev/null || true

ENV HOST=0.0.0.0
ENV WS_PORT=8765
ENV CAPTURE_PORT=8766
ENV STACKCHAN_MODE=nian
ENV PYTHONUNBUFFERED=1

EXPOSE 8765 8766

CMD ["python", "-m", "stackchan_mcp"]
