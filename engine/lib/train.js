/**
 * Bucle walk-forward compartido por el entrenamiento y el backtesting.
 *
 * Recorre el histórico en orden cronológico y, en cada partido posterior al
 * periodo de calentamiento, predice con modelos entrenados SÓLO con partidos
 * anteriores. Después registra el resultado y avanza. De ahí salen a la vez:
 *   - los modelos finales listos para predecir la jornada de hoy
 *   - los pesos del ensamble y la calibración (ajustados fuera de muestra)
 *   - el histórico de predicciones para medir Brier, acierto y ROI
 */

import { fitDixonColes } from './poisson.js';
import { trainElo } from './elo.js';
import { trainMultinomial, featureImportance } from './logreg.js';
import { TeamStateTracker, FEATURE_NAMES } from './features.js';
import { predictFixture, optimizeWeights, DEFAULT_WEIGHTS } from './ensemble.js';
import { fitTemperature } from './calibration.js';

export function outcomeOf(match) {
  if (match.homeGoals > match.awayGoals) return 'home';
  if (match.homeGoals === match.awayGoals) return 'draw';
  return 'away';
}

export function walkForward(matches, options = {}) {
  const {
    warmup = 200,
    refitEveryDays = 14,
    dcIterations = 400,
    mlMinRows = 150,
    maxMlRows = 5000,
    onPrediction = null,
    onProgress = null,
  } = options;

  const ordered = [...matches]
    .filter((m) => m.homeGoals !== null && m.awayGoals !== null && m.date)
    .sort((a, b) => a.date - b.date);

  const tracker = new TeamStateTracker();
  const history = [];
  const records = [];
  const mlRows = [];

  let dcModel = null;
  let eloModel = null;
  let mlModel = null;
  let lastFit = null;
  let weights = { ...DEFAULT_WEIGHTS };
  let calibration = { temperature: 1 };
  let refits = 0;

  for (const match of ordered) {
    if (history.length >= warmup) {
      const needsRefit = !dcModel || (match.date - lastFit) / 86400000 >= refitEveryDays;
      if (needsRefit) {
        dcModel = fitDixonColes(history, { reference: match.date, iterations: dcIterations });
        eloModel = trainElo(history);
        lastFit = match.date;
        refits += 1;

        if (mlRows.length >= mlMinRows) {
          mlModel = trainMultinomial(
            mlRows.map((r) => r.vector),
            mlRows.map((r) => r.outcome),
            null,
            { iterations: 400, featureNames: FEATURE_NAMES },
          );
        }
        if (records.length >= 150) {
          const recent = records.slice(-1500);
          weights = optimizeWeights(recent.map((r) => ({ parts: r.parts, outcome: r.outcome })));
          calibration = fitTemperature(
            recent.map((r) => r.raw),
            recent.map((r) => r.outcome),
          );
        }
        onProgress?.(
          `Reajuste ${refits} en ${match.date.toISOString().slice(0, 10)} · ${history.length} partidos`,
        );
      }

      const feats = tracker.featuresFor(match, { eloModel, dcModel });
      const prediction = predictFixture(
        match,
        { dcModel, eloModel, mlModel, weights, calibration },
        feats.vector,
      );
      const outcome = outcomeOf(match);

      records.push({
        date: match.date,
        league: match.league ?? null,
        leagueId: match.leagueId ?? null,
        raw: prediction.probabilities,
        parts: prediction.parts,
        probabilities: prediction.probabilities,
        outcome,
      });
      mlRows.push({ vector: feats.vector, outcome });
      if (mlRows.length > maxMlRows) mlRows.shift();

      onPrediction?.({ match, prediction, features: feats, outcome, tracker });
    }

    tracker.record(match);
    history.push(match);
  }

  // Ajuste final con todo el histórico disponible, para predecir hoy.
  const reference = new Date();
  if (history.length >= 30) {
    dcModel = fitDixonColes(history, { reference, iterations: 600 });
    eloModel = trainElo(history);
  }
  if (mlRows.length >= mlMinRows) {
    mlModel = trainMultinomial(
      mlRows.map((r) => r.vector),
      mlRows.map((r) => r.outcome),
      null,
      { iterations: 700, featureNames: FEATURE_NAMES },
    );
  }
  if (records.length >= 150) {
    const recent = records.slice(-1500);
    weights = optimizeWeights(recent.map((r) => ({ parts: r.parts, outcome: r.outcome })));
    calibration = fitTemperature(recent.map((r) => r.raw), recent.map((r) => r.outcome));
  }

  return {
    dcModel,
    eloModel,
    mlModel,
    weights,
    calibration,
    tracker,
    records,
    refits,
    matchesUsed: history.length,
    featureImportance: mlModel ? featureImportance(mlModel).slice(0, 8) : [],
  };
}
