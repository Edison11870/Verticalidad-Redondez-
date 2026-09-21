# Valor Diario — apuestas de fútbol con valor esperado positivo

Web estática que cada día publica los partidos de las principales competiciones
del mundo con la probabilidad que les da un modelo propio, la compara con las
cuotas del mercado y muestra sólo las apuestas con valor esperado positivo.
Incluye combinadas en tres niveles de riesgo y un historial de aciertos **y
fallos** verificable.

Se publica sin tocar el sitio existente del repositorio: vive en `/apuestas/`.

```
https://<usuario>.github.io/Verticalidad-Redondez-/apuestas/
```

## Puesta en marcha

```bash
npm test                 # comprueba el motor (16 pruebas)
npm run demo             # genera datos simulados y llena la web
npm run serve            # sirve en http://localhost:8080/apuestas/
```

Sin claves de API el sistema arranca en **modo demostración**: simula dos
temporadas de resultados y un mercado de cuotas, y ejecuta con ellos exactamente
el mismo modelo, backtesting y constructor de combinadas que en producción. La
web avisa de ello en todas las vistas.

### Con datos reales

| Variable | Proveedor | Para qué |
|---|---|---|
| `API_FOOTBALL_KEY` | [api-sports.io](https://www.api-football.com/) | partidos, resultados, xG, lesiones y alineaciones |
| `FOOTBALL_DATA_KEY` | [football-data.org](https://www.football-data.org/) | alternativa gratuita (menos ligas, sin xG ni lesiones) |
| `ODDS_API_KEY` | [the-odds-api.com](https://the-odds-api.com/) | cuotas de varias casas para comparar |

```bash
export API_FOOTBALL_KEY=...
export ODDS_API_KEY=...
npm run update           # actualización diaria completa
npm run prematch         # refresco de cuotas y alineaciones antes de los partidos
```

Sin `ODDS_API_KEY` el sistema sigue calculando probabilidades, pero no puede
detectar valor: sin cuota no hay con qué comparar.

### Actualización automática

`.github/workflows/actualizar-apuestas.yml` hace una pasada completa a las 06:20
UTC y refrescos prepartido a las 11:00, 15:00 y 18:00 UTC; después publica los
JSON actualizados en el repositorio. Guarda las claves en *Settings → Secrets and
variables → Actions*. El flujo usa `--strict`: si faltan las claves, falla en vez
de sustituir los datos reales por una demostración.

## Cómo se calcula

1. **Dixon-Coles** (`engine/lib/poisson.js`). Poisson bivariado con ataque y
   defensa por equipo, ventaja de localía, **nivel de goles propio de cada
   competición** y la corrección `rho` para marcadores bajos. Se ajusta por
   escalado iterativo de Poisson (cada parámetro tiene solución cerrada dado el
   resto), con regularización hacia el equipo medio y decaimiento temporal.
2. **Elo** (`engine/lib/elo.js`), con multiplicador por diferencia de goles.
3. **Regresión logística multinomial** (`engine/lib/logreg.js`) sobre 14
   variables: forma de los últimos 10 partidos, xG a favor y en contra,
   diferencia de goles, días de descanso, congestión de calendario, impacto de
   bajas, historial directo y campo neutral. Sustituye al XGBoost del diseño
   original: misma familia de variables, sin dependencias y con coeficientes
   legibles para poder explicar cada pronóstico.
4. **Ensamble** (`engine/lib/ensemble.js`). Los pesos se eligen minimizando el
   log loss fuera de muestra; después se calibra por *temperature scaling*.
5. **Mercado como prior**. La cuota de consenso sin margen se mezcla con la
   predicción, con un peso que sube si hay muchas casas y poco margen.
6. **Todos los mercados salen de una sola matriz de marcadores**, ajustando las
   lambdas hasta reproducir el 1X2 del ensamble. Así 1X2, doble oportunidad,
   más/menos, ambos anotan y hándicap nunca se contradicen entre sí.
7. **Valor** (`engine/lib/value.js`). Se quita el margen por el método de
   potencias sobre el **consenso**, se compara con el modelo y la apuesta se
   registra a la **mejor cuota** disponible. Stake por Kelly fraccionario (¼).

### Decisiones que cambian los resultados

- **Usar el mercado como prior no es rendirse, es lo que evita perder dinero.**
  Comparando el modelo crudo contra la cuota, el filtro de valor se queda
  justamente con los partidos donde el modelo más se equivoca. En el backtesting
  del repositorio eso convertía un ROI positivo en −8%.
- **El margen se quita sobre el consenso, nunca sobre la mejor cuota.**
  Quitárselo a la mejor cuota inventa valor que no existe.
- **El consenso se promedia en probabilidad implícita, no en cuota.** Promediar
  cuotas sobrevalora las altas.

## Validación

`engine/lib/backtest.js` recorre el histórico en orden cronológico y, en cada
fecha, reentrena **sólo con partidos anteriores** (walk-forward). Mide acierto,
ROI, Brier score, log loss y error de calibración, y aplica el mismo prior de
mercado y los mismos filtros que la web: si el backtesting y la portada no
usaran las mismas reglas, el ROI medido no significaría nada.

En la demo, el historial publicado procede del backtesting y sus métricas
cuadran con las de la pestaña *Modelo* — si no cuadran, hay un error.

> **Sobre el mercado simulado de la demo.** La casa simulada no conoce las
> fuerzas verdaderas: las estima con error, como una casa real, y aplica el
> sesgo favorito-outsider documentado en la literatura. Si cotizara con la
> verdad exacta sería un oráculo y ningún modelo podría encontrar valor jamás:
> el backtesting sólo mediría el margen de la casa.

## Estructura

```
apuestas/
  index.html            vistas Hoy · Mañana · Combinadas · Historial · Modelo
  assets/css/styles.css mobile-first, modo oscuro por defecto
  assets/js/app.js      render y gráficos SVG, sin dependencias
  data/                 latest.json · history.json · backtest.json (los genera el motor)
engine/
  run.js                actualización diaria / prepartido
  pipeline.js           de los datos crudos al JSON de la web
  config.js             competiciones y umbrales de valor
  demo.js               generador de datos simulados
  test.js               pruebas del motor
  lib/                  poisson · elo · logreg · features · ensemble · calibration
                        markets · value · parlays · backtest · train · store · names
  sources/              apiFootball · footballData · oddsApi · http
```

Los IDs de liga de API-Football pueden cambiar entre temporadas. Si una
competición deja de traer partidos, compruébalo con
`GET https://v3.football.api-sports.io/leagues?search=<nombre>` y actualiza
`engine/config.js`.

La paleta de los gráficos está verificada para daltonismo (separación CVD
ΔE 9.4, visión normal ΔE 20.9 sobre la superficie oscura) y cada gráfico tiene
su tabla de datos equivalente.

## Aviso

Ninguna predicción garantiza resultados. Una apuesta con 80% de probabilidad se
pierde una de cada cinco veces, y eso no es un fallo del modelo: es lo que
significa 80%. Apuesta sólo lo que puedas perder, nunca más de 2,5 unidades
(1 unidad = 1% del bankroll) por apuesta ni 12 unidades al día, y no persigas
pérdidas. Prohibido para menores de 18 años.
