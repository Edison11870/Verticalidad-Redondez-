/** Cliente HTTP con reintentos, backoff exponencial y límite de peticiones. */

const DEFAULT_TIMEOUT = 20000;

export class RequestBudget {
  constructor(limit = Infinity) {
    this.limit = limit;
    this.used = 0;
  }

  consume(n = 1) {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }

  get remaining() {
    return this.limit - this.used;
  }
}

export async function getJson(url, options = {}) {
  const { data } = await getJsonWithHeaders(url, options);
  return data;
}

/**
 * Igual que getJson pero devuelve también las cabeceras: The Odds API informa
 * del crédito restante en `x-requests-remaining`, y sin leerlo no hay forma de
 * saber cuánto queda del plan hasta que deja de responder.
 */
export async function getJsonWithHeaders(url, { headers = {}, retries = 3, timeout = DEFAULT_TIMEOUT } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 2000 * 2 ** attempt;
        await sleep(Math.min(wait, 30000));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} en ${safeUrl(url)}: ${body.slice(0, 200)}`);
      }
      return { data: await res.json(), headers: res.headers };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === retries) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError ?? new Error(`Fallo al pedir ${safeUrl(url)}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Oculta claves de API al registrar errores. */
export function safeUrl(url) {
  return String(url).replace(/(apiKey|api_key|token)=[^&]+/gi, '$1=***');
}
