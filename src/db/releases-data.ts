/** Shared localized releases data — imported by seed-releases.ts and postgres.ts */

export interface LocalizedRelease {
  version: string;
  released_at: string;
  highlight: { en: string; es: string; fr: string; de: string };
  features: { en: string[]; es: string[]; fr: string[]; de: string[] };
  fixes: { en: string[]; es: string[]; fr: string[]; de: string[] };
}

export const RELEASES: LocalizedRelease[] = [
  // ── v1.3.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v1.3.0",
    released_at: "2026-03-13",
    highlight: {
      en: "Database-backed changelog with full EN/ES/FR/DE locale support, new-release notification dot, and sticky Manage Agent header.",
      es: "Changelog respaldado por base de datos con soporte completo de idiomas EN/ES/FR/DE, punto de notificación de nueva versión y encabezado sticky de Gestión de Agente.",
      fr: "Journal des modifications basé sur la base de données avec support complet des langues EN/ES/FR/DE, point de notification de nouvelle version et en-tête sticky de Gestion d'Agent.",
      de: "Datenbank-gestütztes Changelog mit vollständiger EN/ES/FR/DE-Sprachunterstützung, Benachrichtigungspunkt für neue Versionen und fixierter Manage-Agent-Header.",
    },
    features: {
      en: [
        "🗄️ DB-backed changelog — release notes now stored in PostgreSQL/SQLite with ON CONFLICT upsert; auto-seeded on every backend deploy",
        "🌐 Full locale support — highlight, features, and fixes translated into EN, ES, FR, and DE; content switches instantly with the language selector",
        "🔵 New-release notification dot — blue dot on the changelog button whenever a version the user hasn't seen is shipped; dismissed on first open, persisted in localStorage",
        "📌 Sticky Manage Agent header — AgentIdentityHeader, EquityCurveChart, and MetricsRow stay visible while scrolling through positions and logs",
        "🔧 AutopilotControlCard — ExecutionLog now only renders when Telegram is configured",
      ],
      es: [
        "🗄️ Changelog respaldado por BD — las notas de versión ahora se almacenan en PostgreSQL/SQLite con upsert ON CONFLICT; se siembran automáticamente en cada despliegue del backend",
        "🌐 Soporte completo de idiomas — highlight, características y correcciones traducidos a EN, ES, FR y DE; el contenido cambia instantáneamente con el selector de idioma",
        "🔵 Punto de notificación de nueva versión — punto azul en el botón del changelog cuando se publica una versión que el usuario no ha visto; se descarta al primer clic, persistido en localStorage",
        "📌 Encabezado sticky de Gestión de Agente — AgentIdentityHeader, EquityCurveChart y MetricsRow permanecen visibles al desplazarse por posiciones y registros",
        "🔧 AutopilotControlCard — ExecutionLog ahora solo se renderiza cuando Telegram está configurado",
      ],
      fr: [
        "🗄️ Changelog basé sur la BD — les notes de version sont maintenant stockées dans PostgreSQL/SQLite avec upsert ON CONFLICT ; semées automatiquement à chaque déploiement backend",
        "🌐 Support complet des langues — le highlight, les fonctionnalités et les correctifs traduits en EN, ES, FR et DE ; le contenu change instantanément avec le sélecteur de langue",
        "🔵 Point de notification de nouvelle version — point bleu sur le bouton changelog quand une version non vue par l'utilisateur est publiée ; rejeté à la première ouverture, persisté dans localStorage",
        "📌 En-tête sticky de Gestion d'Agent — AgentIdentityHeader, EquityCurveChart et MetricsRow restent visibles en faisant défiler les positions et les journaux",
        "🔧 AutopilotControlCard — ExecutionLog ne s'affiche maintenant que lorsque Telegram est configuré",
      ],
      de: [
        "🗄️ DB-gestütztes Changelog — Versionshinweise werden jetzt in PostgreSQL/SQLite mit ON CONFLICT Upsert gespeichert; bei jedem Backend-Deploy automatisch geseedet",
        "🌐 Vollständige Sprachunterstützung — Highlight, Features und Fixes in EN, ES, FR und DE übersetzt; Inhalt wechselt sofort mit dem Sprachselektor",
        "🔵 Benachrichtigungspunkt für neue Versionen — blauer Punkt auf dem Changelog-Button wenn eine vom Nutzer noch nicht gesehene Version veröffentlicht wird; beim ersten Öffnen verworfen, in localStorage gespeichert",
        "📌 Fixierter Manage-Agent-Header — AgentIdentityHeader, EquityCurveChart und MetricsRow bleiben beim Scrollen durch Positionen und Logs sichtbar",
        "🔧 AutopilotControlCard — ExecutionLog wird jetzt nur angezeigt wenn Telegram konfiguriert ist",
      ],
    },
    fixes: {
      en: [
        "🔧 layout.tsx: overflowX hidden → clip to fix sticky child element rendering",
        "⚙️ ExecutionLog: trade id coercion ?? → || for safer fallback",
        "🗑️ Old static RELEASES array removed from frontend bundle — data now comes from API",
      ],
      es: [
        "🔧 layout.tsx: overflowX hidden → clip para corregir el renderizado de elementos sticky",
        "⚙️ ExecutionLog: coerción de id de trade ?? → || para fallback más seguro",
        "🗑️ Array RELEASES estático antiguo eliminado del bundle del frontend — los datos ahora vienen de la API",
      ],
      fr: [
        "🔧 layout.tsx : overflowX hidden → clip pour corriger le rendu des éléments sticky",
        "⚙️ ExecutionLog : coercition d'id de trade ?? → || pour un fallback plus sûr",
        "🗑️ Ancien tableau RELEASES statique supprimé du bundle frontend — les données viennent maintenant de l'API",
      ],
      de: [
        "🔧 layout.tsx: overflowX hidden → clip zur Behebung von Sticky-Element-Rendering",
        "⚙️ ExecutionLog: Trade-ID-Koerzion ?? → || für sichereren Fallback",
        "🗑️ Altes statisches RELEASES-Array aus dem Frontend-Bundle entfernt — Daten kommen jetzt von der API",
      ],
    },
  },

  // ── v1.2.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v1.2.0",
    released_at: "2026-03-12",
    highlight: {
      en: "ScannerFeed overhaul, PolymarketStatus enhancements, RelayChatSidebar polish, and Dashboard live data.",
      es: "Rediseño del ScannerFeed, mejoras en PolymarketStatus, pulido de RelayChatSidebar y datos en vivo del Dashboard.",
      fr: "Refonte du ScannerFeed, améliorations du PolymarketStatus, finition du RelayChatSidebar et données live du Dashboard.",
      de: "ScannerFeed-Überarbeitung, PolymarketStatus-Verbesserungen, RelayChatSidebar-Feinschliff und Dashboard-Livedaten.",
    },
    features: {
      en: [
        "📡 ScannerFeed overhaul — live market data, improved scoring visualization",
        "📊 PolymarketStatus enhancements — richer status cards with real-time indicators",
        "💬 RelayChatSidebar polish — smoother UX, better message rendering",
        "📈 Dashboard live data — real-time metrics wired to backend streams",
      ],
      es: [
        "📡 Rediseño del ScannerFeed — datos de mercado en vivo, visualización de puntuación mejorada",
        "📊 Mejoras en PolymarketStatus — tarjetas de estado más ricas con indicadores en tiempo real",
        "💬 Pulido de RelayChatSidebar — UX más fluida, mejor renderizado de mensajes",
        "📈 Datos en vivo del Dashboard — métricas en tiempo real conectadas a streams del backend",
      ],
      fr: [
        "📡 Refonte du ScannerFeed — données de marché en direct, meilleure visualisation des scores",
        "📊 Améliorations du PolymarketStatus — cartes de statut enrichies avec indicateurs en temps réel",
        "💬 Finition du RelayChatSidebar — UX plus fluide, meilleur rendu des messages",
        "📈 Données live du Dashboard — métriques en temps réel connectées aux flux backend",
      ],
      de: [
        "📡 ScannerFeed-Überarbeitung — Live-Marktdaten, verbesserte Score-Visualisierung",
        "📊 PolymarketStatus-Verbesserungen — reichhaltigere Statuskarten mit Echtzeit-Indikatoren",
        "💬 RelayChatSidebar-Feinschliff — flüssigere UX, besseres Nachrichten-Rendering",
        "📈 Dashboard-Livedaten — Echtzeit-Metriken mit Backend-Streams verbunden",
      ],
    },
    fixes: {
      en: [
        "🔧 UI polish pass on multiple components",
        "⚙️ Deployment configuration fixes",
        "🔐 Auth module stabilization",
      ],
      es: [
        "🔧 Pasada de pulido de UI en múltiples componentes",
        "⚙️ Correcciones de configuración de despliegue",
        "🔐 Estabilización del módulo de autenticación",
      ],
      fr: [
        "🔧 Passe de finition UI sur plusieurs composants",
        "⚙️ Corrections de configuration de déploiement",
        "🔐 Stabilisation du module d'authentification",
      ],
      de: [
        "🔧 UI-Feinschliff an mehreren Komponenten",
        "⚙️ Deployment-Konfigurationskorrekturen",
        "🔐 Stabilisierung des Auth-Moduls",
      ],
    },
  },

  // ── v1.1.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v1.1.0",
    released_at: "2026-03-11",
    highlight: {
      en: "Translation improvements, auth module fixes, and deployment stabilization.",
      es: "Mejoras de traducción, correcciones del módulo de autenticación y estabilización del despliegue.",
      fr: "Améliorations des traductions, corrections du module d'authentification et stabilisation du déploiement.",
      de: "Übersetzungsverbesserungen, Auth-Modul-Korrekturen und Deployment-Stabilisierung.",
    },
    features: {
      en: [
        "🌐 Translation improvements across all supported locales",
        "🔐 Auth module hardening — Clerk integration stabilized",
        "🚀 Deployment pipeline fixes for smoother CI/CD",
      ],
      es: [
        "🌐 Mejoras de traducción en todos los idiomas soportados",
        "🔐 Refuerzo del módulo de autenticación — integración de Clerk estabilizada",
        "🚀 Correcciones del pipeline de despliegue para CI/CD más fluido",
      ],
      fr: [
        "🌐 Améliorations des traductions pour toutes les langues supportées",
        "🔐 Renforcement du module d'authentification — intégration Clerk stabilisée",
        "🚀 Corrections du pipeline de déploiement pour un CI/CD plus fluide",
      ],
      de: [
        "🌐 Übersetzungsverbesserungen für alle unterstützten Sprachen",
        "🔐 Auth-Modul-Härtung — Clerk-Integration stabilisiert",
        "🚀 Deployment-Pipeline-Korrekturen für reibungsloseres CI/CD",
      ],
    },
    fixes: {
      en: [
        "🔧 Locale fallback handling for missing translation keys",
        "⚙️ Auth token validation edge cases resolved",
      ],
      es: [
        "🔧 Manejo de fallback de idiomas para claves de traducción faltantes",
        "⚙️ Casos extremos de validación de tokens de autenticación resueltos",
      ],
      fr: [
        "🔧 Gestion du fallback de langue pour les clés de traduction manquantes",
        "⚙️ Cas limites de validation des tokens d'authentification résolus",
      ],
      de: [
        "🔧 Sprach-Fallback-Behandlung für fehlende Übersetzungsschlüssel",
        "⚙️ Auth-Token-Validierungsfälle behoben",
      ],
    },
  },

  // ── v1.0.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v1.0.0",
    released_at: "2026-03-09",
    highlight: {
      en: "Full internationalization (EN/ES/FR/DE), PolymarketStatusCard, language switcher with flag icons — production-ready milestone.",
      es: "Internacionalización completa (EN/ES/FR/DE), PolymarketStatusCard, selector de idioma con iconos de banderas — hito de producción.",
      fr: "Internationalisation complète (EN/ES/FR/DE), PolymarketStatusCard, sélecteur de langue avec drapeaux — jalon prêt pour la production.",
      de: "Vollständige Internationalisierung (EN/ES/FR/DE), PolymarketStatusCard, Sprachauswahl mit Flaggen-Icons — produktionsreifer Meilenstein.",
    },
    features: {
      en: [
        "🌐 Full i18n migration — all UI text externalized into EN, ES, FR, and DE locale files",
        "🏳️ Language switcher with flag icons — instant locale switching in sidebar",
        "📊 PolymarketStatusCard — real-time Polymarket connection status and account info",
        "🎨 Component polish — consistent glass-morphism styling across all panels",
      ],
      es: [
        "🌐 Migración i18n completa — todo el texto de la UI externalizado en archivos de idioma EN, ES, FR y DE",
        "🏳️ Selector de idioma con iconos de banderas — cambio instantáneo de idioma en la barra lateral",
        "📊 PolymarketStatusCard — estado de conexión de Polymarket en tiempo real e información de cuenta",
        "🎨 Pulido de componentes — estilo glass-morphism consistente en todos los paneles",
      ],
      fr: [
        "🌐 Migration i18n complète — tout le texte de l'UI externalisé dans les fichiers de langue EN, ES, FR et DE",
        "🏳️ Sélecteur de langue avec drapeaux — changement instantané de langue dans la barre latérale",
        "📊 PolymarketStatusCard — statut de connexion Polymarket en temps réel et informations du compte",
        "🎨 Finition des composants — style glass-morphism cohérent sur tous les panneaux",
      ],
      de: [
        "🌐 Vollständige i18n-Migration — gesamter UI-Text in EN, ES, FR und DE Sprachdateien ausgelagert",
        "🏳️ Sprachauswahl mit Flaggen-Icons — sofortiger Sprachwechsel in der Seitenleiste",
        "📊 PolymarketStatusCard — Echtzeit-Verbindungsstatus und Kontoinformationen für Polymarket",
        "🎨 Komponenten-Feinschliff — einheitliches Glass-Morphism-Styling über alle Panels",
      ],
    },
    fixes: {
      en: [
        "🔧 Cypress → Playwright migration — more stable E2E tests",
        "⚙️ Clerk environment variables added to CI pipeline",
        "🗑️ Cleaned tracked test artifacts from repository",
      ],
      es: [
        "🔧 Migración Cypress → Playwright — tests E2E más estables",
        "⚙️ Variables de entorno de Clerk añadidas al pipeline de CI",
        "🗑️ Artefactos de prueba rastreados eliminados del repositorio",
      ],
      fr: [
        "🔧 Migration Cypress → Playwright — tests E2E plus stables",
        "⚙️ Variables d'environnement Clerk ajoutées au pipeline CI",
        "🗑️ Artefacts de test suivis supprimés du dépôt",
      ],
      de: [
        "🔧 Cypress → Playwright Migration — stabilere E2E-Tests",
        "⚙️ Clerk-Umgebungsvariablen zur CI-Pipeline hinzugefügt",
        "🗑️ Getrackte Test-Artefakte aus dem Repository bereinigt",
      ],
    },
  },

  // ── v0.9.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.9.0",
    released_at: "2026-03-07",
    highlight: {
      en: "Dashboard redesign with mission rail, mini-map, wallet checks, and sidebar overhaul.",
      es: "Rediseño del Dashboard con barra de misiones, mini-mapa, verificaciones de wallet y rediseño de la barra lateral.",
      fr: "Refonte du Dashboard avec rail de mission, mini-carte, vérifications de portefeuille et refonte de la barre latérale.",
      de: "Dashboard-Neugestaltung mit Missions-Rail, Mini-Map, Wallet-Checks und Sidebar-Überarbeitung.",
    },
    features: {
      en: [
        "🗺️ Dashboard mission rail — guided onboarding steps visible at all times",
        "🔍 Mini-map — visual overview of active markets and positions",
        "💰 Wallet checks — automated balance verification on dashboard load",
        "🎨 Sidebar redesign — cleaner navigation, locked agent leverage display",
        "📊 Dashboard refactored to client component for better reactivity",
      ],
      es: [
        "🗺️ Barra de misiones del Dashboard — pasos de incorporación guiados visibles en todo momento",
        "🔍 Mini-mapa — vista visual de mercados activos y posiciones",
        "💰 Verificaciones de wallet — verificación automática de saldo al cargar el dashboard",
        "🎨 Rediseño de barra lateral — navegación más limpia, visualización de apalancamiento de agente bloqueado",
        "📊 Dashboard refactorizado a componente cliente para mejor reactividad",
      ],
      fr: [
        "🗺️ Rail de mission du Dashboard — étapes d'intégration guidées visibles en permanence",
        "🔍 Mini-carte — aperçu visuel des marchés actifs et des positions",
        "💰 Vérifications de portefeuille — vérification automatique du solde au chargement du dashboard",
        "🎨 Refonte de la barre latérale — navigation plus claire, affichage du levier d'agent verrouillé",
        "📊 Dashboard refactoré en composant client pour une meilleure réactivité",
      ],
      de: [
        "🗺️ Dashboard-Missions-Rail — geführte Onboarding-Schritte jederzeit sichtbar",
        "🔍 Mini-Map — visuelle Übersicht über aktive Märkte und Positionen",
        "💰 Wallet-Checks — automatische Saldoprüfung beim Dashboard-Laden",
        "🎨 Sidebar-Neugestaltung — sauberere Navigation, gesperrte Agent-Leverage-Anzeige",
        "📊 Dashboard zu Client-Komponente refaktoriert für bessere Reaktivität",
      ],
    },
    fixes: { en: [], es: [], fr: [], de: [] },
  },

  // ── v0.8.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.8.0",
    released_at: "2026-03-05",
    highlight: {
      en: "BYO Agent system, Agent World pixel environment, Architecture View, and Agent Factory refactor.",
      es: "Sistema BYO Agent, entorno pixel Agent World, Vista de Arquitectura y refactorización de Agent Factory.",
      fr: "Système BYO Agent, environnement pixel Agent World, Vue Architecture et refactorisation de l'Agent Factory.",
      de: "BYO-Agent-System, Agent World Pixel-Umgebung, Architektur-Ansicht und Agent Factory Refactoring.",
    },
    features: {
      en: [
        "🔌 BYO Agent system — bring your own external agents via MCP server protocol",
        "🎮 Agent World — pixel art virtual environment powered by Phaser 3",
        "🏗️ Architecture View — interactive system diagram of all agent connections",
        "🏭 Agent Factory refactor — streamlined agent creation flow and hooks",
        "📋 Onboarding flow — agent-limit UI, autopilot card, webhook and wallet setup",
        "📚 BYO documentation page with integration guides",
      ],
      es: [
        "🔌 Sistema BYO Agent — conecta tus agentes externos via protocolo de servidor MCP",
        "🎮 Agent World — entorno virtual de pixel art impulsado por Phaser 3",
        "🏗️ Vista de Arquitectura — diagrama interactivo del sistema de todas las conexiones de agentes",
        "🏭 Refactorización de Agent Factory — flujo de creación de agentes simplificado con hooks",
        "📋 Flujo de onboarding — UI de límite de agentes, tarjeta de autopilot, configuración de webhook y wallet",
        "📚 Página de documentación BYO con guías de integración",
      ],
      fr: [
        "🔌 Système BYO Agent — connectez vos agents externes via le protocole serveur MCP",
        "🎮 Agent World — environnement virtuel en pixel art propulsé par Phaser 3",
        "🏗️ Vue Architecture — diagramme système interactif de toutes les connexions d'agents",
        "🏭 Refactorisation de l'Agent Factory — flux de création d'agents simplifié avec hooks",
        "📋 Flux d'intégration — UI de limite d'agents, carte autopilot, configuration webhook et portefeuille",
        "📚 Page de documentation BYO avec guides d'intégration",
      ],
      de: [
        "🔌 BYO-Agent-System — eigene externe Agenten via MCP-Server-Protokoll anbinden",
        "🎮 Agent World — Pixel-Art-Virtualumgebung mit Phaser 3",
        "🏗️ Architektur-Ansicht — interaktives Systemdiagramm aller Agent-Verbindungen",
        "🏭 Agent Factory Refactoring — vereinfachter Agenten-Erstellungsfluss mit Hooks",
        "📋 Onboarding-Ablauf — Agent-Limit-UI, Autopilot-Karte, Webhook- und Wallet-Einrichtung",
        "📚 BYO-Dokumentationsseite mit Integrationsanleitungen",
      ],
    },
    fixes: {
      en: ["🔧 Agent status endpoint now uses live API instead of hardcoded values"],
      es: ["🔧 El endpoint de estado del agente ahora usa la API en vivo en lugar de valores hardcodeados"],
      fr: ["🔧 L'endpoint de statut d'agent utilise maintenant l'API en direct au lieu de valeurs codées en dur"],
      de: ["🔧 Agent-Status-Endpoint verwendet jetzt Live-API statt hartcodierter Werte"],
    },
  },

  // ── v0.7.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.7.0",
    released_at: "2026-03-02",
    highlight: {
      en: "First live trade placed on Polymarket CLOB",
      es: "Primera operación en vivo realizada en Polymarket CLOB",
      fr: "Première transaction en direct placée sur Polymarket CLOB",
      de: "Erster Live-Trade auf Polymarket CLOB platziert",
    },
    features: {
      en: [
        "💹 Market orders (FOK) — fills immediately at market price, no stale bids",
        "💰 USDC.e live wallet funded ($247.59 on Polygon)",
        "📉 BET_NO correctly buys NO token (clobTokenIds[1])",
        "📊 Attribution dashboard reads from executions table",
        "📋 Version changelog system in sidebar",
      ],
      es: [
        "💹 Órdenes de mercado (FOK) — se ejecutan inmediatamente al precio de mercado, sin ofertas obsoletas",
        "💰 Wallet USDC.e en vivo financiada ($247.59 en Polygon)",
        "📉 BET_NO compra correctamente el token NO (clobTokenIds[1])",
        "📊 Panel de atribución lee de la tabla de ejecuciones",
        "📋 Sistema de changelog de versiones en la barra lateral",
      ],
      fr: [
        "💹 Ordres au marché (FOK) — exécutés immédiatement au prix du marché, pas d'offres périmées",
        "💰 Portefeuille USDC.e en direct financé (247,59 $ sur Polygon)",
        "📉 BET_NO achète correctement le token NO (clobTokenIds[1])",
        "📊 Tableau d'attribution lit depuis la table des exécutions",
        "📋 Système de changelog des versions dans la barre latérale",
      ],
      de: [
        "💹 Market-Orders (FOK) — sofortige Ausführung zum Marktpreis, keine veralteten Gebote",
        "💰 USDC.e Live-Wallet finanziert ($247,59 auf Polygon)",
        "📉 BET_NO kauft korrekt den NO-Token (clobTokenIds[1])",
        "📊 Attributions-Dashboard liest aus der Ausführungstabelle",
        "📋 Versions-Changelog-System in der Seitenleiste",
      ],
    },
    fixes: {
      en: [
        "🔧 safeBigInt guard — no more 0x crash on RPC empty response",
        "⚙️ Flux CLI orderbook→book (correct subcommand)",
        "🗑️ Removed 4 dead RPCs (polygon-rpc.com, maticvigil, meowrpc, omniatech)",
        "🔧 Fixed scanner_results query (removed nonexistent yes_price column)",
        "⚙️ pnlSettler SQL string literals (single-quotes for status values)",
      ],
      es: [
        "🔧 Guardia safeBigInt — sin más crashes 0x en respuesta vacía de RPC",
        "⚙️ Flux CLI orderbook→book (subcomando correcto)",
        "🗑️ 4 RPCs muertos eliminados (polygon-rpc.com, maticvigil, meowrpc, omniatech)",
        "🔧 Consulta scanner_results corregida (columna yes_price inexistente eliminada)",
        "⚙️ Literales de cadena SQL de pnlSettler (comillas simples para valores de estado)",
      ],
      fr: [
        "🔧 Garde safeBigInt — plus de crash 0x sur réponse RPC vide",
        "⚙️ Flux CLI orderbook→book (sous-commande correcte)",
        "🗑️ 4 RPC morts supprimés (polygon-rpc.com, maticvigil, meowrpc, omniatech)",
        "🔧 Requête scanner_results corrigée (colonne yes_price inexistante supprimée)",
        "⚙️ Littéraux SQL de pnlSettler (guillemets simples pour les valeurs de statut)",
      ],
      de: [
        "🔧 safeBigInt-Guard — kein 0x-Crash mehr bei leerer RPC-Antwort",
        "⚙️ Flux CLI orderbook→book (korrekter Unterbefehl)",
        "🗑️ 4 tote RPCs entfernt (polygon-rpc.com, maticvigil, meowrpc, omniatech)",
        "🔧 scanner_results-Abfrage korrigiert (nicht existierende yes_price-Spalte entfernt)",
        "⚙️ pnlSettler SQL-Stringliterale (einfache Anführungszeichen für Statuswerte)",
      ],
    },
  },

  // ── v0.6.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.6.0",
    released_at: "2026-03-02",
    highlight: {
      en: "Persistent SQLite on Railway volume",
      es: "SQLite persistente en volumen de Railway",
      fr: "SQLite persistant sur le volume Railway",
      de: "Persistentes SQLite auf Railway-Volume",
    },
    features: {
      en: [
        "💾 Railway persistent volume (/data/quantik.db)",
        "📊 Simulated P&L for paper trades (entry vs current scanner price)",
        "💰 fill_price stored at execution time",
        "🏦 CLOB balance health endpoint /api/clob/balance",
        "🔓 CLOB allowances set at startup (max_uint256)",
      ],
      es: [
        "💾 Volumen persistente de Railway (/data/quantik.db)",
        "📊 P&L simulado para operaciones de papel (entrada vs precio actual del scanner)",
        "💰 fill_price almacenado en tiempo de ejecución",
        "🏦 Endpoint de salud de balance CLOB /api/clob/balance",
        "🔓 Permisos CLOB establecidos al inicio (max_uint256)",
      ],
      fr: [
        "💾 Volume persistant Railway (/data/quantik.db)",
        "📊 P&L simulé pour les trades papier (entrée vs prix scanner actuel)",
        "💰 fill_price stocké au moment de l'exécution",
        "🏦 Endpoint de santé du solde CLOB /api/clob/balance",
        "🔓 Autorisations CLOB définies au démarrage (max_uint256)",
      ],
      de: [
        "💾 Railway persistentes Volume (/data/quantik.db)",
        "📊 Simuliertes P&L für Papier-Trades (Einstieg vs aktueller Scanner-Preis)",
        "💰 fill_price zum Ausführungszeitpunkt gespeichert",
        "🏦 CLOB-Balance-Health-Endpoint /api/clob/balance",
        "🔓 CLOB-Genehmigungen beim Start gesetzt (max_uint256)",
      ],
    },
    fixes: {
      en: [
        "🔧 Portfolio summary reads from executions table (not missing trades table)",
        "⚙️ Trade history returns real executions as trades[]",
        "🗑️ TS2869 nullish unreachable errors in marketScanner",
      ],
      es: [
        "🔧 Resumen de portafolio lee de tabla de ejecuciones (no de tabla de trades faltante)",
        "⚙️ Historial de trades devuelve ejecuciones reales como trades[]",
        "🗑️ Errores TS2869 nullish inalcanzables en marketScanner",
      ],
      fr: [
        "🔧 Résumé du portefeuille lit depuis la table des exécutions (pas la table trades manquante)",
        "⚙️ L'historique des trades retourne les exécutions réelles comme trades[]",
        "🗑️ Erreurs TS2869 nullish inaccessibles dans marketScanner",
      ],
      de: [
        "🔧 Portfolio-Zusammenfassung liest aus Ausführungstabelle (nicht fehlende Trades-Tabelle)",
        "⚙️ Trade-Historie gibt echte Ausführungen als trades[] zurück",
        "🗑️ TS2869 Nullish-Unreachable-Fehler im marketScanner",
      ],
    },
  },

  // ── v0.5.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.5.0",
    released_at: "2026-03-01",
    highlight: {
      en: "Full autonomous pipeline with real agents",
      es: "Pipeline autónomo completo con agentes reales",
      fr: "Pipeline autonome complet avec agents réels",
      de: "Vollständige autonome Pipeline mit echten Agenten",
    },
    features: {
      en: [
        "📊 Scanner sorts by liquidity (not volume)",
        "🚫 Sports/esports markets excluded from scanner",
        "🔮 Oracle runs via direct import (no HTTP self-call)",
        "📰 GNews RSS integration for Aura — real-time news, no API key",
        "📐 Synthesized Kelly when Kelly=0 via oracle divergence",
        "💰 Real yesPrice in market_price alert field",
        "✅ FAILED / LIVE status labels in alerts",
      ],
      es: [
        "📊 El scanner ordena por liquidez (no por volumen)",
        "🚫 Mercados de deportes/esports excluidos del scanner",
        "🔮 Oracle se ejecuta por importación directa (sin auto-llamada HTTP)",
        "📰 Integración GNews RSS para Aura — noticias en tiempo real, sin clave API",
        "📐 Kelly sintetizado cuando Kelly=0 via divergencia de Oracle",
        "💰 yesPrice real en el campo market_price de alertas",
        "✅ Etiquetas de estado FAILED / LIVE en alertas",
      ],
      fr: [
        "📊 Le scanner trie par liquidité (pas par volume)",
        "🚫 Marchés sportifs/esports exclus du scanner",
        "🔮 Oracle s'exécute par import direct (pas d'auto-appel HTTP)",
        "📰 Intégration GNews RSS pour Aura — actualités en temps réel, sans clé API",
        "📐 Kelly synthétisé quand Kelly=0 via la divergence Oracle",
        "💰 yesPrice réel dans le champ market_price des alertes",
        "✅ Labels de statut FAILED / LIVE dans les alertes",
      ],
      de: [
        "📊 Scanner sortiert nach Liquidität (nicht Volumen)",
        "🚫 Sport-/Esport-Märkte vom Scanner ausgeschlossen",
        "🔮 Oracle läuft über direkten Import (kein HTTP-Selbstaufruf)",
        "📰 GNews RSS-Integration für Aura — Echtzeit-Nachrichten, kein API-Key",
        "📐 Synthetisierter Kelly wenn Kelly=0 über Oracle-Divergenz",
        "💰 Echter yesPrice im market_price-Alertfeld",
        "✅ FAILED / LIVE Statuslabels in Alerts",
      ],
    },
    fixes: {
      en: [
        "🔧 Edge INSERT OR REPLACE + correlation timeout",
        "⚙️ Sigma weighted confidence (Oracle×3, Clause×2, Edge×2, Flux×1, Aura×1)",
        "🔧 CLI stdout capture (polymarket prints errors to stdout)",
        "🗑️ Duplicate -o json flag removed",
        "⚙️ Price rounded to 2dp for CLOB tick size (0.01 minimum)",
      ],
      es: [
        "🔧 Edge INSERT OR REPLACE + timeout de correlación",
        "⚙️ Confianza ponderada de Sigma (Oracle×3, Clause×2, Edge×2, Flux×1, Aura×1)",
        "🔧 Captura de stdout del CLI (polymarket imprime errores en stdout)",
        "🗑️ Flag -o json duplicado eliminado",
        "⚙️ Precio redondeado a 2dp para tamaño de tick CLOB (mínimo 0.01)",
      ],
      fr: [
        "🔧 Edge INSERT OR REPLACE + timeout de corrélation",
        "⚙️ Confiance pondérée de Sigma (Oracle×3, Clause×2, Edge×2, Flux×1, Aura×1)",
        "🔧 Capture stdout du CLI (polymarket imprime les erreurs sur stdout)",
        "🗑️ Flag -o json en double supprimé",
        "⚙️ Prix arrondi à 2dp pour la taille de tick CLOB (minimum 0,01)",
      ],
      de: [
        "🔧 Edge INSERT OR REPLACE + Korrelations-Timeout",
        "⚙️ Sigma gewichtete Konfidenz (Oracle×3, Clause×2, Edge×2, Flux×1, Aura×1)",
        "🔧 CLI stdout-Erfassung (polymarket gibt Fehler auf stdout aus)",
        "🗑️ Doppeltes -o json Flag entfernt",
        "⚙️ Preis auf 2 Dezimalstellen gerundet für CLOB-Tick-Größe (Minimum 0,01)",
      ],
    },
  },

  // ── v0.4.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.4.0",
    released_at: "2026-03-01",
    highlight: {
      en: "CI gate — 69 tests block every deploy",
      es: "Gate CI — 69 pruebas bloquean cada despliegue",
      fr: "Gate CI — 69 tests bloquent chaque déploiement",
      de: "CI-Gate — 69 Tests blockieren jedes Deployment",
    },
    features: {
      en: [
        "🧪 Backend: 8 real API contract tests gate Railway deploys",
        "🧪 Frontend: Cypress Tier1 (37 tests) + Tier2 (24 tests) gate Vercel deploys",
        "🔌 SSE mock pattern with ReadableStream stub",
        "📊 /api/execution/log endpoint",
        "🔍 Scanner market coverage expanded",
      ],
      es: [
        "🧪 Backend: 8 pruebas de contrato API reales bloquean despliegues de Railway",
        "🧪 Frontend: Cypress Tier1 (37 pruebas) + Tier2 (24 pruebas) bloquean despliegues de Vercel",
        "🔌 Patrón de mock SSE con stub de ReadableStream",
        "📊 Endpoint /api/execution/log",
        "🔍 Cobertura de mercados del scanner ampliada",
      ],
      fr: [
        "🧪 Backend : 8 tests de contrat API réels bloquent les déploiements Railway",
        "🧪 Frontend : Cypress Tier1 (37 tests) + Tier2 (24 tests) bloquent les déploiements Vercel",
        "🔌 Pattern de mock SSE avec stub ReadableStream",
        "📊 Endpoint /api/execution/log",
        "🔍 Couverture des marchés du scanner étendue",
      ],
      de: [
        "🧪 Backend: 8 echte API-Vertragstests blockieren Railway-Deployments",
        "🧪 Frontend: Cypress Tier1 (37 Tests) + Tier2 (24 Tests) blockieren Vercel-Deployments",
        "🔌 SSE-Mock-Pattern mit ReadableStream-Stub",
        "📊 /api/execution/log Endpoint",
        "🔍 Scanner-Marktabdeckung erweitert",
      ],
    },
    fixes: {
      en: [
        "🔧 CI: jest flag --testPathPattern removed in jest 30",
        "⚙️ Markets GET /:slug normalizes tokenId from Gamma",
        "⚙️ Price-history returns flat array from CLOB REST API",
      ],
      es: [
        "🔧 CI: flag jest --testPathPattern eliminado en jest 30",
        "⚙️ Markets GET /:slug normaliza tokenId desde Gamma",
        "⚙️ Price-history devuelve array plano desde CLOB REST API",
      ],
      fr: [
        "🔧 CI : flag jest --testPathPattern supprimé dans jest 30",
        "⚙️ Markets GET /:slug normalise le tokenId depuis Gamma",
        "⚙️ Price-history retourne un tableau plat depuis l'API REST CLOB",
      ],
      de: [
        "🔧 CI: jest Flag --testPathPattern in jest 30 entfernt",
        "⚙️ Markets GET /:slug normalisiert tokenId von Gamma",
        "⚙️ Price-history gibt flaches Array von der CLOB REST API zurück",
      ],
    },
  },

  // ── v0.3.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.3.0",
    released_at: "2026-02-28",
    highlight: {
      en: "All 7 specialist agents live",
      es: "Los 7 agentes especialistas en vivo",
      fr: "Les 7 agents spécialisés en direct",
      de: "Alle 7 Spezialagenten live",
    },
    features: {
      en: [
        "🤖 Real agents in scanner (Oracle, Edge, Sigma, Clause, Aura, Flux)",
        "📊 Performance endpoint with Brier scores",
        "💰 PnL settler (30-min cycle)",
        "🔥 Relay pre-warm + heartbeat",
        "📈 Market scoring pipeline",
        "🛡️ Circuit breaker hardening",
        "😈 Lucifer dynamic per-market devil's advocate analysis",
        "🔗 Order ID + Polymarket verification link in alerts",
      ],
      es: [
        "🤖 Agentes reales en el scanner (Oracle, Edge, Sigma, Clause, Aura, Flux)",
        "📊 Endpoint de rendimiento con puntuaciones Brier",
        "💰 Liquidador de PnL (ciclo de 30 min)",
        "🔥 Pre-calentamiento de Relay + heartbeat",
        "📈 Pipeline de puntuación de mercados",
        "🛡️ Refuerzo de circuit breaker",
        "😈 Análisis dinámico de abogado del diablo de Lucifer por mercado",
        "🔗 ID de orden + enlace de verificación de Polymarket en alertas",
      ],
      fr: [
        "🤖 Agents réels dans le scanner (Oracle, Edge, Sigma, Clause, Aura, Flux)",
        "📊 Endpoint de performance avec scores de Brier",
        "💰 Régleur de PnL (cycle de 30 min)",
        "🔥 Pré-chauffe Relay + heartbeat",
        "📈 Pipeline de notation des marchés",
        "🛡️ Renforcement du circuit breaker",
        "😈 Analyse dynamique de l'avocat du diable de Lucifer par marché",
        "🔗 ID d'ordre + lien de vérification Polymarket dans les alertes",
      ],
      de: [
        "🤖 Echte Agenten im Scanner (Oracle, Edge, Sigma, Clause, Aura, Flux)",
        "📊 Performance-Endpoint mit Brier-Scores",
        "💰 PnL-Settler (30-Min-Zyklus)",
        "🔥 Relay-Vorwärmung + Heartbeat",
        "📈 Markt-Scoring-Pipeline",
        "🛡️ Circuit-Breaker-Härtung",
        "😈 Luzifers dynamische Advocatus-Diaboli-Analyse pro Markt",
        "🔗 Order-ID + Polymarket-Verifizierungslink in Alerts",
      ],
    },
    fixes: {
      en: [
        "🔧 Flux CLI-only orderbook (removed broken CLOB API fallback)",
        "⚙️ Scanner INSERT OR REPLACE",
        "⚙️ Agent field mappings (fractional_kelly, riskLevel, confidence)",
        "🔧 Relay: never echo raw JSON in responses",
      ],
      es: [
        "🔧 Libro de órdenes solo CLI de Flux (fallback de API CLOB roto eliminado)",
        "⚙️ Scanner INSERT OR REPLACE",
        "⚙️ Mapeos de campos de agentes (fractional_kelly, riskLevel, confidence)",
        "🔧 Relay: nunca hacer eco de JSON crudo en respuestas",
      ],
      fr: [
        "🔧 Carnet d'ordres CLI uniquement de Flux (fallback API CLOB cassé supprimé)",
        "⚙️ Scanner INSERT OR REPLACE",
        "⚙️ Mappages de champs d'agents (fractional_kelly, riskLevel, confidence)",
        "🔧 Relay : ne jamais renvoyer du JSON brut dans les réponses",
      ],
      de: [
        "🔧 Flux nur CLI-Orderbuch (defektes CLOB-API-Fallback entfernt)",
        "⚙️ Scanner INSERT OR REPLACE",
        "⚙️ Agenten-Feldzuordnungen (fractional_kelly, riskLevel, confidence)",
        "🔧 Relay: niemals rohes JSON in Antworten wiedergeben",
      ],
    },
  },

  // ── v0.2.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.2.0",
    released_at: "2026-02-28",
    highlight: {
      en: "Relay chat + Autopilot dashboard",
      es: "Chat Relay + Dashboard de Autopilot",
      fr: "Chat Relay + Dashboard Autopilot",
      de: "Relay-Chat + Autopilot-Dashboard",
    },
    features: {
      en: [
        "💬 Relay SSE streaming — TTFT ~250ms, word-by-word tokens",
        "🤖 Autopilot dashboard — scanner feed, execution log, P&L ticker",
        "🎨 RelayChat with model badge, latency, agent chips, glassmorphism",
        "💡 Always-visible suggested follow-up question pills",
        "⌨️ Relay typing indicator",
      ],
      es: [
        "💬 Streaming SSE de Relay — TTFT ~250ms, tokens palabra por palabra",
        "🤖 Dashboard de Autopilot — feed del scanner, registro de ejecución, ticker de P&L",
        "🎨 RelayChat con badge de modelo, latencia, chips de agentes, glassmorphism",
        "💡 Píldoras de preguntas sugeridas siempre visibles",
        "⌨️ Indicador de escritura de Relay",
      ],
      fr: [
        "💬 Streaming SSE Relay — TTFT ~250ms, tokens mot par mot",
        "🤖 Dashboard Autopilot — flux scanner, journal d'exécution, ticker P&L",
        "🎨 RelayChat avec badge de modèle, latence, chips d'agents, glassmorphism",
        "💡 Pilules de questions suggérées toujours visibles",
        "⌨️ Indicateur de frappe Relay",
      ],
      de: [
        "💬 Relay SSE-Streaming — TTFT ~250ms, Wort-für-Wort-Tokens",
        "🤖 Autopilot-Dashboard — Scanner-Feed, Ausführungslog, P&L-Ticker",
        "🎨 RelayChat mit Modell-Badge, Latenz, Agent-Chips, Glassmorphism",
        "💡 Immer sichtbare vorgeschlagene Folgefrage-Pills",
        "⌨️ Relay-Tippindikator",
      ],
    },
    fixes: {
      en: [
        "🔧 PipelineLog rewrite — reliable queue drainer, no stale closures",
        "⚙️ Chart uses clobTokenIds[0] as tokenId",
        "⚙️ SSE event parsing in runPipeline",
        "🔧 Relay system prompt — 50-word limit, humanizer enforced",
      ],
      es: [
        "🔧 Reescritura de PipelineLog — drenaje de cola confiable, sin closures obsoletos",
        "⚙️ Gráfico usa clobTokenIds[0] como tokenId",
        "⚙️ Parsing de eventos SSE en runPipeline",
        "🔧 Prompt de sistema de Relay — límite de 50 palabras, humanizer forzado",
      ],
      fr: [
        "🔧 Réécriture de PipelineLog — draineur de file d'attente fiable, pas de fermetures obsolètes",
        "⚙️ Le graphique utilise clobTokenIds[0] comme tokenId",
        "⚙️ Parsing des événements SSE dans runPipeline",
        "🔧 Prompt système Relay — limite de 50 mots, humanizer imposé",
      ],
      de: [
        "🔧 PipelineLog-Neuschreibung — zuverlässiger Queue-Drainer, keine veralteten Closures",
        "⚙️ Chart verwendet clobTokenIds[0] als tokenId",
        "⚙️ SSE-Event-Parsing in runPipeline",
        "🔧 Relay-Systemprompt — 50-Wort-Limit, Humanizer erzwungen",
      ],
    },
  },

  // ── v0.1.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.1.0",
    released_at: "2026-02-27",
    highlight: {
      en: "All 5 frontend layers shipped",
      es: "Las 5 capas del frontend desplegadas",
      fr: "Les 5 couches frontend livrées",
      de: "Alle 5 Frontend-Schichten ausgeliefert",
    },
    features: {
      en: [
        "📊 L1: Dashboard with live market scanner feed",
        "📡 L2: Signal Generation — RecentSignals wired to /api/signals",
        "🛡️ L3: Risk panel — circuit breaker, live exposure",
        "💹 L4: Execute Trade wired to /api/execution/order",
        "📈 L5: PerformancePanel, Brier scores, attribution, drift status",
        "🎯 Market page full rebuild — live pipeline log, chart, Terminal X design",
      ],
      es: [
        "📊 L1: Dashboard con feed del scanner de mercados en vivo",
        "📡 L2: Generación de Señales — RecentSignals conectado a /api/signals",
        "🛡️ L3: Panel de Riesgo — circuit breaker, exposición en vivo",
        "💹 L4: Ejecutar Trade conectado a /api/execution/order",
        "📈 L5: Panel de Rendimiento, puntuaciones Brier, atribución, estado de drift",
        "🎯 Reconstrucción completa de la página de mercados — log de pipeline en vivo, gráfico, diseño Terminal X",
      ],
      fr: [
        "📊 L1 : Dashboard avec flux scanner de marchés en direct",
        "📡 L2 : Génération de Signaux — RecentSignals connecté à /api/signals",
        "🛡️ L3 : Panneau de Risque — circuit breaker, exposition en direct",
        "💹 L4 : Exécuter Trade connecté à /api/execution/order",
        "📈 L5 : Panneau de Performance, scores de Brier, attribution, statut de dérive",
        "🎯 Reconstruction complète de la page marchés — log pipeline en direct, graphique, design Terminal X",
      ],
      de: [
        "📊 L1: Dashboard mit Live-Markt-Scanner-Feed",
        "📡 L2: Signalgenerierung — RecentSignals verbunden mit /api/signals",
        "🛡️ L3: Risikopanel — Circuit Breaker, Live-Exposure",
        "💹 L4: Trade ausführen verbunden mit /api/execution/order",
        "📈 L5: Performance-Panel, Brier-Scores, Attribution, Drift-Status",
        "🎯 Marktseite komplett neu gebaut — Live-Pipeline-Log, Chart, Terminal X Design",
      ],
    },
    fixes: {
      en: [
        "🧪 Cypress catches TypeError crashes + market page error state",
        "⚙️ Agent output normalization",
        "⚙️ circuitBreaker API response normalization",
      ],
      es: [
        "🧪 Cypress captura crashes TypeError + estado de error de la página de mercados",
        "⚙️ Normalización de salida de agentes",
        "⚙️ Normalización de respuesta API de circuitBreaker",
      ],
      fr: [
        "🧪 Cypress attrape les crashes TypeError + état d'erreur de la page marchés",
        "⚙️ Normalisation de la sortie des agents",
        "⚙️ Normalisation de la réponse API du circuitBreaker",
      ],
      de: [
        "🧪 Cypress fängt TypeError-Crashes + Marktseiten-Fehlerzustand",
        "⚙️ Agenten-Ausgabe-Normalisierung",
        "⚙️ circuitBreaker API-Antwort-Normalisierung",
      ],
    },
  },

  // ── v0.0.1 ──────────────────────────────────────────────────────────────────
  {
    version: "v0.0.1",
    released_at: "2026-02-27",
    highlight: {
      en: "Project initialized",
      es: "Proyecto inicializado",
      fr: "Projet initialisé",
      de: "Projekt initialisiert",
    },
    features: {
      en: [
        "🚀 Quantik autonomous Polymarket trading platform",
        "🏗️ Layer 0–5 architecture (data → signal → execution → monitoring)",
        "⚛️ Next.js 15 frontend on Vercel",
        "🖥️ Node/Express backend on Railway",
        "🗄️ SQLite database with 20+ tables",
      ],
      es: [
        "🚀 Plataforma de trading autónomo Quantik para Polymarket",
        "🏗️ Arquitectura Layer 0–5 (datos → señal → ejecución → monitoreo)",
        "⚛️ Frontend Next.js 15 en Vercel",
        "🖥️ Backend Node/Express en Railway",
        "🗄️ Base de datos SQLite con 20+ tablas",
      ],
      fr: [
        "🚀 Plateforme de trading autonome Quantik pour Polymarket",
        "🏗️ Architecture Layer 0–5 (données → signal → exécution → surveillance)",
        "⚛️ Frontend Next.js 15 sur Vercel",
        "🖥️ Backend Node/Express sur Railway",
        "🗄️ Base de données SQLite avec 20+ tables",
      ],
      de: [
        "🚀 Quantik autonome Polymarket-Handelsplattform",
        "🏗️ Layer 0–5 Architektur (Daten → Signal → Ausführung → Überwachung)",
        "⚛️ Next.js 15 Frontend auf Vercel",
        "🖥️ Node/Express Backend auf Railway",
        "🗄️ SQLite-Datenbank mit 20+ Tabellen",
      ],
    },
    fixes: { en: [], es: [], fr: [], de: [] },
  },
];
