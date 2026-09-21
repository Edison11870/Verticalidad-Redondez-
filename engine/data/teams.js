/**
 * Plantillas de equipos por competición, usadas SÓLO por el generador de datos
 * de demostración (engine/demo.js). Con claves de API reales estos nombres no
 * se utilizan: todo viene del proveedor.
 */

export const ROSTERS = {
  epl: ['Arsenal', 'Manchester City', 'Liverpool', 'Chelsea', 'Tottenham', 'Manchester United', 'Newcastle', 'Aston Villa', 'Brighton', 'West Ham', 'Everton', 'Fulham'],
  laliga: ['Real Madrid', 'Barcelona', 'Atlético Madrid', 'Athletic Club', 'Real Sociedad', 'Villarreal', 'Real Betis', 'Sevilla', 'Valencia', 'Girona', 'Osasuna', 'Celta de Vigo'],
  seriea: ['Inter', 'Milan', 'Juventus', 'Napoli', 'Atalanta', 'Roma', 'Lazio', 'Fiorentina', 'Bologna', 'Torino', 'Udinese', 'Genoa'],
  bundesliga: ['Bayern Múnich', 'Bayer Leverkusen', 'Borussia Dortmund', 'RB Leipzig', 'Stuttgart', 'Eintracht Frankfurt', 'Wolfsburgo', 'Friburgo', 'Hoffenheim', 'Werder Bremen'],
  ligue1: ['Paris Saint-Germain', 'Mónaco', 'Marsella', 'Lille', 'Lyon', 'Niza', 'Lens', 'Rennes', 'Estrasburgo', 'Nantes'],
  ucl: ['Real Madrid', 'Manchester City', 'Bayern Múnich', 'Inter', 'Paris Saint-Germain', 'Arsenal', 'Barcelona', 'Liverpool', 'Atlético Madrid', 'Borussia Dortmund', 'Milan', 'Benfica', 'Porto', 'Ajax', 'Napoli', 'Juventus'],
  uel: ['Roma', 'Sevilla', 'Villarreal', 'Ajax', 'Rangers', 'Feyenoord', 'Olympiacos', 'Real Sociedad', 'Lazio', 'Fenerbahçe', 'Betis', 'Braga'],
  peru: ['Universitario', 'Alianza Lima', 'Sporting Cristal', 'Melgar', 'Cusco FC', 'Sport Huancayo', 'Cienciano', 'ADT', 'Alianza Atlético', 'Los Chankas'],
  libertadores: ['Flamengo', 'Palmeiras', 'River Plate', 'Boca Juniors', 'Peñarol', 'Nacional', 'Atlético Mineiro', 'Botafogo', 'Universitario', 'Colo-Colo', 'Independiente del Valle', 'Racing Club'],
  sudamericana: ['Lanús', 'Corinthians', 'Independiente', 'Fortaleza', 'Always Ready', 'Cerro Porteño', 'Sporting Cristal', 'Universidad Católica', 'Defensa y Justicia', 'Cruzeiro'],
  mls: ['Inter Miami', 'LAFC', 'Columbus Crew', 'Philadelphia Union', 'Seattle Sounders', 'Cincinnati', 'LA Galaxy', 'Atlanta United', 'Orlando City', 'New York Red Bulls'],
  brasileirao: ['Botafogo', 'Palmeiras', 'Flamengo', 'Fortaleza', 'Internacional', 'São Paulo', 'Corinthians', 'Bahia', 'Cruzeiro', 'Grêmio'],
  argentina: ['River Plate', 'Boca Juniors', 'Racing Club', 'Vélez Sarsfield', 'Estudiantes', 'Talleres', 'San Lorenzo', 'Independiente', 'Lanús', 'Huracán'],
  eredivisie: ['PSV', 'Feyenoord', 'Ajax', 'AZ Alkmaar', 'Twente', 'Utrecht', 'Sparta Rotterdam', 'Go Ahead Eagles'],
  primeira: ['Sporting CP', 'Benfica', 'Porto', 'Braga', 'Vitória Guimarães', 'Arouca', 'Famalicão', 'Moreirense'],
  championship: ['Leeds United', 'Burnley', 'Sheffield United', 'Sunderland', 'Middlesbrough', 'West Bromwich', 'Coventry', 'Norwich City'],
  liga_mx: ['América', 'Cruz Azul', 'Monterrey', 'Tigres', 'Guadalajara', 'Toluca', 'Pumas', 'Pachuca', 'León', 'Santos Laguna'],
  wc_qual_sa: ['Argentina', 'Brasil', 'Uruguay', 'Colombia', 'Ecuador', 'Perú', 'Paraguay', 'Chile', 'Bolivia', 'Venezuela'],
  wc_qual_eu: ['Francia', 'España', 'Inglaterra', 'Portugal', 'Países Bajos', 'Italia', 'Alemania', 'Bélgica', 'Croacia', 'Dinamarca'],
  worldcup: ['Argentina', 'Brasil', 'Francia', 'España', 'Inglaterra', 'Portugal', 'Países Bajos', 'Alemania', 'Uruguay', 'Perú', 'México', 'Estados Unidos'],
};

/** Fuerza base aproximada por liga (nivel medio de la competición). */
export const LEAGUE_STRENGTH = {
  ucl: 1.18, uel: 1.02, epl: 1.12, laliga: 1.1, seriea: 1.08, bundesliga: 1.08,
  ligue1: 1.04, peru: 0.9, libertadores: 1.0, sudamericana: 0.95, mls: 0.94,
  brasileirao: 1.0, argentina: 0.98, eredivisie: 1.0, primeira: 1.0,
  championship: 0.96, liga_mx: 0.96, wc_qual_sa: 1.0, wc_qual_eu: 1.05, worldcup: 1.1,
};
