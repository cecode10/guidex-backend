/** Wikidata ids missing due to narrow settlement instance-type whitelist. */
export const INSTANCE_TYPE_GAP_WIKIDATA_IDS = [
    "Q64", // Berlin
    "Q2807", // Madrid
    "Q9248", // Baku
    "Q90", // Paris
    "Q1110343", // Vélez-Rubio
    "Q16665884", // Métropole Aix-Marseille-Provence
    "Q1781", // Budapest
    "Q16665897", // Metropolis of Lyon
    "Q472", // Sofia
    "Q32664319", // München
    "Q8818", // Valencia
    "Q10305", // Zaragoza
    "Q8717", // Seville
    "Q1209", // Bremen
    "Q619690", // Vélez de Benaudalla
    "Q8851", // Málaga
    "Q12225", // Murcia
    "Q8692", // Bilbao
    "Q11974", // Las Palmas de Gran Canaria
    "Q14112", // Corsica
    "Q1312589", // Bonrepòs i Mirambell
    "Q5818", // Córdoba
    "Q8356", // Valladolid
    "Q8810", // Granada
    "Q14318", // Vitoria-Gasteiz
    "Q2861", // Rostock
    "Q10509", // Elche
    "Q14328", // Santa Cruz de Tenerife
    "Q162615", // Cartagena
    "Q12303", // Jerez de la Frontera
    "Q10282", // Pamplona
    "Q10400", // Almería
    "Q46940", // Alcalá de Henares
    "Q54902", // Fuenlabrada
    "Q8802", // Getafe
    "Q10313", // San Sebastián
    "Q12233", // Santander
    "Q9580", // Burgos
    "Q10372", // Alcorcón
    "Q15095", // Albacete
    "Q15695", // Salamanca
    "Q484799", // Marbella
    "Q14325", // Logroño
    "Q12246", // Huelva
    "Q15699", // León
    "Q489839", // Torrejón de Ardoz
    "Q489205", // Dos Hermanas
    "Q15682", // Cádiz
    "Q824651", // Parla
    "Q3778", // Zwickau
    "Q134494", // Győr
    "Q168668", // Dobrich
    "Q484552", // Algeciras
    "Q55845", // Telde
    "Q15681", // Jaén
    "Q181830", // Shumen
    "Q13972", // Tartu
    "Q499184", // Roquetas de Mar
    "Q221749", // Torrevieja
    "Q185289", // Pernik
    "Q3802", // Hanau
    "Q644481", // Rivas-Vaciamadrid
    "Q3828", // Dessau-Roßlau
    "Q3758", // Kaiserslautern
    "Q487786", // Orihuela
    "Q186576", // Pazardzhik
    "Q187821", // Tatabánya
];

/** Capitals dropped by admin-type exclusion despite population >= 100k. */
export const ADMIN_TYPE_GAP_WIKIDATA_IDS = [
    "Q19660", // Bucharest
    "Q2280", // Minsk
    "Q270", // Warsaw
    "Q994", // Tbilisi
    "Q5328", // Kazan
    "Q1741", // Vienna
];

export const KNOWN_GAP_WIKIDATA_IDS = [
    ...new Set([...INSTANCE_TYPE_GAP_WIKIDATA_IDS, ...ADMIN_TYPE_GAP_WIKIDATA_IDS]),
];
