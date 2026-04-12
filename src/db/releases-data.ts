/** Shared localized releases data — imported by seed-releases.ts and postgres.ts */

export interface LocalizedRelease {
  version: string;
  released_at: string;
  highlight: { en: string; es: string; fr: string; de: string };
  features: { en: string[]; es: string[]; fr: string[]; de: string[] };
  fixes: { en: string[]; es: string[]; fr: string[]; de: string[] };
}

export const RELEASES: LocalizedRelease[] = [
  // ── v1.5.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v1.5.0",
    released_at: "2026-03-21",
    highlight: {
      en: "Agent DNA & Autopilot, Close Position flow, On-chain wallet RPC, Product Onboarding Tour, Public Agent Profiles, Landing Page & PWA, SSE real-time streaming.",
      es: "ADN de Agente y Autopiloto, flujo de Cerrar Posición, RPC de billetera on-chain, Tour de Onboarding del Producto, Perfiles Públicos de Agentes, Landing Page y PWA, streaming en tiempo real SSE.",
      fr: "ADN d'Agent & Autopilote, flux de Fermeture de Position, RPC portefeuille on-chain, Tour d'Onboarding Produit, Profils Publics d'Agents, Landing Page & PWA, streaming temps réel SSE.",
      de: "Agent-DNA & Autopilot, Position-Schließen-Flow, On-Chain-Wallet-RPC, Produkt-Onboarding-Tour, Öffentliche Agentenprofile, Landing Page & PWA, SSE-Echtzeit-Streaming.",
    },
    features: {
      en: [
        "🧬 Agent DNA — strategy fingerprint analysis for each agent, powering Arena comparisons and public profiles",
        "🤖 Autopilot System — full agent autopilot management with Polymarket readiness checks and policy setup",
        "💰 Close Position — new execution flow to close open positions with standardized execution types",
        "🔗 On-Chain Wallet RPC — agent wallet balance fetching via on-chain RPC instead of API, with wallet secret re-encryption for PostgreSQL",
        "🏆 Arena Enhancements — agent badges, heat scores, performance snapshots, history tracking, and head-to-head comparison API",
        "📡 Telegram Alerts — rich formatting with confidence bars, risk badges, dynamic Polymarket event URLs, and improved thesis cleaning",
        "📊 Monitoring Endpoints — async drift detection and P&L attribution with full PostgreSQL support",
        "🎓 Product Onboarding Tour — guided interactive tutorial with i18n, replacing the previous tutorial system",
        "🏠 Landing Page — new public landing page with comprehensive loading/error states and PWA/SEO capabilities",
        "👤 Public Agent Profiles — shareable agent profile pages with following functionality in the live activity feed",
        "⚡ SSE Real-Time Updates — Server-Sent Events for live streaming, complementing existing Socket.io infrastructure",
        "🎨 Glassmorphism UI — unified glass-morphism design system with shared font styles, node status utilities, and CSS animation consolidation",
        "🔐 Clerk UI Polish — hidden branding, styled input placeholders, badges, and footer actions",
        "🏗️ Centralized Agent Constants — agent metadata, status utilities, and factory UI components consolidated into shared modules",
      ],
      es: [
        "🧬 ADN de Agente — análisis de huella digital de estrategia para cada agente, impulsando comparaciones de Arena y perfiles públicos",
        "🤖 Sistema de Autopiloto — gestión completa del autopiloto de agentes con verificaciones de preparación para Polymarket y configuración de políticas",
        "💰 Cerrar Posición — nuevo flujo de ejecución para cerrar posiciones abiertas con tipos de ejecución estandarizados",
        "🔗 RPC de Billetera On-Chain — consulta de saldo de billetera de agentes vía RPC on-chain en lugar de API, con re-encriptación de secretos para PostgreSQL",
        "🏆 Mejoras de Arena — insignias de agentes, puntuaciones de calor, instantáneas de rendimiento, seguimiento de historial y API de comparación directa",
        "📡 Alertas de Telegram — formato enriquecido con barras de confianza, insignias de riesgo, URLs dinámicas de eventos Polymarket y limpieza mejorada de tesis",
        "📊 Endpoints de Monitoreo — detección asíncrona de desviaciones y atribución de P&L con soporte completo de PostgreSQL",
        "🎓 Tour de Onboarding — tutorial interactivo guiado con i18n, reemplazando el sistema de tutorial anterior",
        "🏠 Landing Page — nueva página de inicio pública con estados completos de carga/error y capacidades PWA/SEO",
        "👤 Perfiles Públicos de Agentes — páginas de perfil de agentes compartibles con funcionalidad de seguimiento en el feed de actividad",
        "⚡ Actualizaciones SSE en Tiempo Real — Server-Sent Events para streaming en vivo, complementando la infraestructura existente de Socket.io",
        "🎨 UI Glassmorphism — sistema de diseño unificado de glass-morphism con estilos de fuente compartidos, utilidades de estado de nodos y consolidación de animaciones CSS",
        "🔐 Clerk UI Pulido — marca oculta, placeholders de entrada estilizados, insignias y acciones de pie de página",
        "🏗️ Constantes de Agente Centralizadas — metadatos de agentes, utilidades de estado y componentes de UI de fábrica consolidados en módulos compartidos",
      ],
      fr: [
        "🧬 ADN d'Agent — analyse d'empreinte stratégique pour chaque agent, alimentant les comparaisons Arena et les profils publics",
        "🤖 Système Autopilote — gestion complète de l'autopilote des agents avec vérifications de préparation Polymarket et configuration de politiques",
        "💰 Fermeture de Position — nouveau flux d'exécution pour fermer les positions ouvertes avec types d'exécution standardisés",
        "🔗 RPC Portefeuille On-Chain — consultation du solde du portefeuille via RPC on-chain au lieu de l'API, avec re-chiffrement des secrets pour PostgreSQL",
        "🏆 Améliorations Arena — badges d'agents, scores de chaleur, instantanés de performance, suivi d'historique et API de comparaison directe",
        "📡 Alertes Telegram — formatage enrichi avec barres de confiance, badges de risque, URLs dynamiques d'événements Polymarket et nettoyage amélioré des thèses",
        "📊 Endpoints de Surveillance — détection asynchrone de dérive et attribution de P&L avec support complet PostgreSQL",
        "🎓 Tour d'Onboarding — tutoriel interactif guidé avec i18n, remplaçant l'ancien système de tutoriel",
        "🏠 Landing Page — nouvelle page d'accueil publique avec états de chargement/erreur complets et capacités PWA/SEO",
        "👤 Profils Publics d'Agents — pages de profil d'agents partageables avec fonctionnalité de suivi dans le fil d'activité en direct",
        "⚡ Mises à Jour SSE Temps Réel — Server-Sent Events pour le streaming en direct, complétant l'infrastructure Socket.io existante",
        "🎨 UI Glassmorphism — système de design unifié glass-morphism avec styles de police partagés, utilitaires d'état des nœuds et consolidation des animations CSS",
        "🔐 Clerk UI Poli — marque masquée, placeholders d'entrée stylisés, badges et actions de pied de page",
        "🏗️ Constantes d'Agent Centralisées — métadonnées d'agents, utilitaires d'état et composants d'UI de factory consolidés dans des modules partagés",
      ],
      de: [
        "🧬 Agent-DNA — Strategie-Fingerabdruck-Analyse für jeden Agenten, für Arena-Vergleiche und öffentliche Profile",
        "🤖 Autopilot-System — vollständige Autopilot-Verwaltung mit Polymarket-Bereitschaftsprüfungen und Richtlinien-Setup",
        "💰 Position Schließen — neuer Ausführungsfluss zum Schließen offener Positionen mit standardisierten Ausführungstypen",
        "🔗 On-Chain-Wallet-RPC — Abfrage des Wallet-Guthabens über On-Chain-RPC statt API, mit Neuverschlüsselung der Wallet-Geheimnisse für PostgreSQL",
        "🏆 Arena-Verbesserungen — Agenten-Badges, Heat-Scores, Performance-Snapshots, Verlaufsverfolgung und Kopf-an-Kopf-Vergleichs-API",
        "📡 Telegram-Alarme — reichhaltiges Format mit Vertrauensbalken, Risiko-Badges, dynamischen Polymarket-Event-URLs und verbesserter Thesen-Bereinigung",
        "📊 Monitoring-Endpoints — asynchrone Drift-Erkennung und P&L-Attribution mit vollständiger PostgreSQL-Unterstützung",
        "🎓 Produkt-Onboarding-Tour — geführtes interaktives Tutorial mit i18n, ersetzt das vorherige Tutorialsystem",
        "🏠 Landing Page — neue öffentliche Startseite mit umfassenden Lade-/Fehlerzuständen und PWA/SEO-Fähigkeiten",
        "👤 Öffentliche Agentenprofile — teilbare Agentenprofil-Seiten mit Follow-Funktion im Live-Aktivitäts-Feed",
        "⚡ SSE-Echtzeit-Updates — Server-Sent Events für Live-Streaming, ergänzend zur bestehenden Socket.io-Infrastruktur",
        "🎨 Glassmorphism-UI — einheitliches Glass-Morphism-Designsystem mit gemeinsamen Schriftstilen, Knotenstatus-Utilities und CSS-Animations-Konsolidierung",
        "🔐 Clerk-UI-Feinschliff — versteckte Marke, gestylte Eingabe-Platzhalter, Badges und Footer-Aktionen",
        "🏗️ Zentralisierte Agent-Konstanten — Agenten-Metadaten, Status-Utilities und Factory-UI-Komponenten in gemeinsamen Modulen konsolidiert",
      ],
    },
    fixes: {
      en: [
        "🔧 Unrealized PnL — consolidated calculation into a single accumulator, always included from open positions",
        "🛡️ Circuit Breaker — BIGINT type casts for state updates, improved error handling on riskL3 endpoint",
        "⚡ Redis Scheduler — connectivity check on init, graceful fallback to legacy mode if Redis is unreachable",
        "🔧 Trade Execution — wrapped in try-finally to ensure agent outputs are always flushed",
        "🧪 Test Fixes — updated mocks for `loadAgentWalletContextWithDiag`, fixed autopilotPolicy and pgStability suites",
        "⚙️ Date Parsing — improved `executedAt` parsing, proper `agent_id` casting, and `getClobBalance` null-safety",
      ],
      es: [
        "🔧 PnL No Realizado — cálculo consolidado en un solo acumulador, siempre incluido de posiciones abiertas",
        "🛡️ Circuit Breaker — conversiones de tipo BIGINT para actualizaciones de estado, manejo de errores mejorado en el endpoint riskL3",
        "⚡ Scheduler Redis — verificación de conectividad al iniciar, respaldo graceful al modo legado si Redis no es accesible",
        "🔧 Ejecución de Trades — envuelto en try-finally para asegurar que las salidas de agentes siempre se vacíen",
        "🧪 Correcciones de Tests — mocks actualizados para `loadAgentWalletContextWithDiag`, suites autopilotPolicy y pgStability arregladas",
        "⚙️ Parseo de Fechas — parseo mejorado de `executedAt`, casting apropiado de `agent_id` y seguridad null de `getClobBalance`",
      ],
      fr: [
        "🔧 PnL Non Réalisé — calcul consolidé en un seul accumulateur, toujours inclus des positions ouvertes",
        "🛡️ Circuit Breaker — conversions de type BIGINT pour les mises à jour d'état, gestion d'erreurs améliorée sur l'endpoint riskL3",
        "⚡ Scheduler Redis — vérification de connectivité à l'initialisation, repli gracieux vers le mode legacy si Redis est inaccessible",
        "🔧 Exécution de Trades — enveloppé dans try-finally pour garantir que les sorties des agents sont toujours vidées",
        "🧪 Corrections de Tests — mocks mis à jour pour `loadAgentWalletContextWithDiag`, suites autopilotPolicy et pgStability corrigées",
        "⚙️ Parsing de Dates — parsing amélioré de `executedAt`, casting correct de `agent_id` et sécurité null de `getClobBalance`",
      ],
      de: [
        "🔧 Unrealisierter PnL — Berechnung in einem einzelnen Akkumulator konsolidiert, immer aus offenen Positionen einbezogen",
        "🛡️ Circuit Breaker — BIGINT-Typumwandlungen für Statusaktualisierungen, verbessertes Fehlerhandling am riskL3-Endpoint",
        "⚡ Redis-Scheduler — Konnektivitätsprüfung beim Start, graceful Fallback zum Legacy-Modus wenn Redis nicht erreichbar",
        "🔧 Trade-Ausführung — in try-finally eingewickelt, um sicherzustellen, dass Agent-Ausgaben immer geflusht werden",
        "🧪 Test-Korrekturen — Mocks für `loadAgentWalletContextWithDiag` aktualisiert, autopilotPolicy- und pgStability-Suiten behoben",
        "⚙️ Datums-Parsing — verbessertes `executedAt`-Parsing, korrektes `agent_id`-Casting und `getClobBalance`-Null-Sicherheit",
      ],
    },
  },

  // ── v1.4.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v1.4.0",
    released_at: "2026-03-15",
    highlight: {
      en: "Arena competitive trading, Notification Center, Market Alerts, Pipeline Replay, AURA data expansion with BLS/FRED/Metaculus adapters.",
      es: "Trading competitivo en Arena, Centro de Notificaciones, Alertas de Mercado, Replay de Pipeline, expansión de datos AURA con adaptadores BLS/FRED/Metaculus.",
      fr: "Trading compétitif Arena, Centre de Notifications, Alertes de Marché, Replay de Pipeline, expansion des données AURA avec adaptateurs BLS/FRED/Metaculus.",
      de: "Arena-Wettbewerbshandel, Benachrichtigungszentrum, Marktalarme, Pipeline-Replay, AURA-Datenerweiterung mit BLS/FRED/Metaculus-Adaptern.",
    },
    features: {
      en: [
        "🏟️ Arena — competitive trading leaderboard with ranking, stats & helpers for head-to-head performance comparison",
        "🔔 Notification Center — real-time inbox with alert management, backed by new notification inbox service & socket events",
        "⚡ Market Alerts — custom condition builder to trigger alerts on price, volume, or resolution changes",
        "🔄 Pipeline Replay — step-through panel to review past agent decisions and signal chains",
        "📊 Trade Reports — analytics view with export for historical trade performance",
        "⏳ Resolution Countdown — live countdown timer for market expiry on market pages",
        "🌗 Theme Toggle — dark/light mode switch with ThemeContext provider",
        "📋 Position Detail Sheet & Quick Action Rail — enhanced Manage Agent UX with one-tap actions",
        "🏗️ Infrastructure Nodes — Architecture View expanded with infra layer and full detail panels",
        "🧠 AURA Agent — 3 new data source adapters: BLS (labor stats), FRED (economic data), Metaculus (forecasting)",
        "🔍 Discovery Route — new API for market exploration and search",
        "🗺️ Markets Page — redesigned with advanced filtering, search & category navigation",
      ],
      es: [
        "🏟️ Arena — tabla de clasificación de trading competitivo con ranking, estadísticas y herramientas de comparación de rendimiento",
        "🔔 Centro de Notificaciones — bandeja de entrada en tiempo real con gestión de alertas, respaldada por nuevo servicio de notificaciones y eventos de socket",
        "⚡ Alertas de Mercado — constructor de condiciones personalizadas para activar alertas por precio, volumen o cambios de resolución",
        "🔄 Replay de Pipeline — panel paso a paso para revisar decisiones pasadas de agentes y cadenas de señales",
        "📊 Informes de Trading — vista analítica con exportación del rendimiento histórico de operaciones",
        "⏳ Cuenta Regresiva de Resolución — temporizador en vivo para la expiración del mercado",
        "🌗 Selector de Tema — cambio entre modo oscuro/claro con proveedor ThemeContext",
        "📋 Hoja de Detalle de Posición y Carril de Acciones Rápidas — UX mejorada de Gestión de Agente con acciones de un toque",
        "🏗️ Nodos de Infraestructura — Vista de Arquitectura expandida con capa de infraestructura y paneles de detalle completos",
        "🧠 Agente AURA — 3 nuevos adaptadores de fuentes de datos: BLS (estadísticas laborales), FRED (datos económicos), Metaculus (pronósticos)",
        "🔍 Ruta de Descubrimiento — nueva API para exploración y búsqueda de mercados",
        "🗺️ Página de Mercados — rediseñada con filtrado avanzado, búsqueda y navegación por categorías",
      ],
      fr: [
        "🏟️ Arena — classement de trading compétitif avec ranking, statistiques et outils de comparaison de performance",
        "🔔 Centre de Notifications — boîte de réception en temps réel avec gestion des alertes, soutenu par un nouveau service de notifications et événements socket",
        "⚡ Alertes de Marché — constructeur de conditions personnalisées pour déclencher des alertes sur les changements de prix, volume ou résolution",
        "🔄 Replay de Pipeline — panneau pas à pas pour revoir les décisions passées des agents et les chaînes de signaux",
        "📊 Rapports de Trading — vue analytique avec export des performances historiques des trades",
        "⏳ Compte à Rebours de Résolution — minuterie en direct pour l'expiration du marché",
        "🌗 Sélecteur de Thème — basculement mode sombre/clair avec fournisseur ThemeContext",
        "📋 Fiche de Détail de Position et Rail d'Actions Rapides — UX améliorée de Gestion d'Agent avec actions en un clic",
        "🏗️ Nœuds d'Infrastructure — Vue Architecture étendue avec couche d'infrastructure et panneaux de détail complets",
        "🧠 Agent AURA — 3 nouveaux adaptateurs de sources de données : BLS (statistiques du travail), FRED (données économiques), Metaculus (prévisions)",
        "🔍 Route de Découverte — nouvelle API pour l'exploration et la recherche de marchés",
        "🗺️ Page des Marchés — redessinée avec filtrage avancé, recherche et navigation par catégories",
      ],
      de: [
        "🏟️ Arena — Wettbewerbs-Trading-Rangliste mit Ranking, Statistiken und Werkzeugen für Leistungsvergleiche",
        "🔔 Benachrichtigungszentrum — Echtzeit-Posteingang mit Alarmverwaltung, unterstützt durch neuen Benachrichtigungsdienst und Socket-Events",
        "⚡ Marktalarme — benutzerdefinierter Bedingungsersteller zum Auslösen von Alarmen bei Preis-, Volumen- oder Auflösungsänderungen",
        "🔄 Pipeline-Replay — Schritt-für-Schritt-Panel zur Überprüfung vergangener Agenten-Entscheidungen und Signalketten",
        "📊 Trading-Berichte — Analyseansicht mit Export der historischen Handelsleistung",
        "⏳ Auflösungs-Countdown — Live-Countdown-Timer für den Marktablauf",
        "🌗 Theme-Umschalter — Dunkel-/Hellmodus-Wechsel mit ThemeContext-Provider",
        "📋 Positionsdetail-Blatt und Schnellaktionsleiste — verbesserte Manage-Agent-UX mit Ein-Tipp-Aktionen",
        "🏗️ Infrastruktur-Knoten — Architekturansicht erweitert mit Infrastrukturschicht und vollständigen Detailpanels",
        "🧠 AURA-Agent — 3 neue Datenquellenadapter: BLS (Arbeitsstatistiken), FRED (Wirtschaftsdaten), Metaculus (Prognosen)",
        "🔍 Discovery-Route — neue API für Marktexploration und Suche",
        "🗺️ Marktseite — neu gestaltet mit erweiterter Filterung, Suche und Kategorienavigation",
      ],
    },
    fixes: {
      en: [
        "🔧 Trade History page refactored for performance — reduced re-renders and optimized data fetching",
        "🛡️ Global Panic Button expanded with additional safety controls and confirmation flows",
        "⚡ Agent Pipeline upgraded with richer signal visualization and validator support",
        "🔧 Market Header redesigned with resolution info and improved layout",
        "🌐 Full i18n coverage for all new features across EN/ES/FR/DE",
      ],
      es: [
        "🔧 Página de Historial de Trading refactorizada para rendimiento — reducción de re-renderizados y optimización de carga de datos",
        "🛡️ Botón de Pánico Global expandido con controles de seguridad adicionales y flujos de confirmación",
        "⚡ Pipeline de Agentes mejorado con visualización de señales más rica y soporte de validador",
        "🔧 Encabezado de Mercado rediseñado con información de resolución y layout mejorado",
        "🌐 Cobertura completa de i18n para todas las nuevas funciones en EN/ES/FR/DE",
      ],
      fr: [
        "🔧 Page d'Historique des Trades refactorisée pour la performance — réduction des re-rendus et optimisation du chargement des données",
        "🛡️ Bouton de Panique Global étendu avec des contrôles de sécurité supplémentaires et des flux de confirmation",
        "⚡ Pipeline d'Agents amélioré avec une visualisation des signaux plus riche et un support de validateur",
        "🔧 En-tête de Marché redessiné avec informations de résolution et layout amélioré",
        "🌐 Couverture i18n complète pour toutes les nouvelles fonctionnalités en EN/ES/FR/DE",
      ],
      de: [
        "🔧 Trade-History-Seite für Leistung refaktoriert — reduzierte Re-Renders und optimiertes Datenladen",
        "🛡️ Globaler Panik-Button erweitert mit zusätzlichen Sicherheitskontrollen und Bestätigungsabläufen",
        "⚡ Agenten-Pipeline aufgerüstet mit reicherer Signalvisualisierung und Validator-Unterstützung",
        "🔧 Markt-Header neu gestaltet mit Auflösungsinfo und verbessertem Layout",
        "🌐 Vollständige i18n-Abdeckung für alle neuen Funktionen in EN/ES/FR/DE",
      ],
    },
  },

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

  // ── v1.6.0 ──────────────────────────────────────────────────────────────────
  {
    version: "v1.6.0",
    released_at: "2026-04-12",
    highlight: {
      en: "ERC-8004 On-Chain Agent Identity, Kraken CLI Trading, Dual-Market Correlation Engine, Multi-Leg Execution with SSE Streaming.",
      es: "Identidad de Agente On-Chain ERC-8004, Trading CLI de Kraken, Motor de Correlación Dual-Market, Ejecución Multi-Leg con Streaming SSE.",
      fr: "Identité d'Agent On-Chain ERC-8004, Trading CLI Kraken, Moteur de Corrélation Dual-Market, Exécution Multi-Leg avec Streaming SSE.",
      de: "ERC-8004 On-Chain-Agentenidentität, Kraken-CLI-Trading, Dual-Market-Korrelations-Engine, Multi-Leg-Ausführung mit SSE-Streaming.",
    },
    features: {
      en: [
        "🔗 ERC-8004 On-Chain Identity — agent registration, reputation scoring, and validation on Sepolia with Identity/Reputation/Validation registries",
        "🦑 Kraken CLI Integration — CLI wrapper with NDJSON parsing, execution engine, and pipeline signal adapter for Kraken trading",
        "📊 Dual-Market Correlation Engine — thesis-aware Kraken mapping, forex/futures correlation, and configurable dual-market mode",
        "🚀 Multi-Leg Execution — asset-class routing with confidence-weighted sizing and SSE streaming for real-time leg updates",
        "🎛️ DualMarketPanel UI — animated Kraken leg visualization in the manage-agent dashboard with live status tracking",
        "📜 Pipeline History — updated pipeline history page with Kraken legs, wallet data, and execution details",
        "🧠 Cross-Market Intelligence — universal correlation engine connecting Polymarket predictions to traditional Kraken markets",
        "✅ ERC-8004 Pipeline Validation — on-chain request/response validation hooks wired into the agent execution flow",
      ],
      es: [
        "🔗 Identidad On-Chain ERC-8004 — registro de agentes, puntuación de reputación y validación en Sepolia con registros de Identidad/Reputación/Validación",
        "🦑 Integración CLI de Kraken — wrapper CLI con parsing NDJSON, motor de ejecución y adaptador de señales de pipeline para trading en Kraken",
        "📊 Motor de Correlación Dual-Market — mapeo de Kraken basado en tesis, correlación forex/futuros y modo dual-market configurable",
        "🚀 Ejecución Multi-Leg — enrutamiento por clase de activo con dimensionamiento ponderado por confianza y streaming SSE para actualizaciones en tiempo real",
        "🎛️ DualMarketPanel UI — visualización animada de legs de Kraken en el dashboard de gestión de agentes con seguimiento de estado en vivo",
        "📜 Historial de Pipeline — página actualizada con legs de Kraken, datos de billetera y detalles de ejecución",
        "🧠 Inteligencia Cross-Market — motor de correlación universal conectando predicciones de Polymarket con mercados tradicionales de Kraken",
        "✅ Validación de Pipeline ERC-8004 — hooks de validación on-chain de solicitud/respuesta integrados en el flujo de ejecución de agentes",
      ],
      fr: [
        "🔗 Identité On-Chain ERC-8004 — enregistrement d'agents, scoring de réputation et validation sur Sepolia avec registres Identité/Réputation/Validation",
        "🦑 Intégration CLI Kraken — wrapper CLI avec parsing NDJSON, moteur d'exécution et adaptateur de signaux pipeline pour le trading Kraken",
        "📊 Moteur de Corrélation Dual-Market — mapping Kraken basé sur la thèse, corrélation forex/futures et mode dual-market configurable",
        "🚀 Exécution Multi-Leg — routage par classe d'actif avec dimensionnement pondéré par confiance et streaming SSE pour les mises à jour en temps réel",
        "🎛️ DualMarketPanel UI — visualisation animée des legs Kraken dans le tableau de bord de gestion d'agents avec suivi de statut en direct",
        "📜 Historique de Pipeline — page mise à jour avec legs Kraken, données de portefeuille et détails d'exécution",
        "🧠 Intelligence Cross-Market — moteur de corrélation universel connectant les prédictions Polymarket aux marchés traditionnels Kraken",
        "✅ Validation Pipeline ERC-8004 — hooks de validation on-chain requête/réponse intégrés dans le flux d'exécution des agents",
      ],
      de: [
        "🔗 ERC-8004 On-Chain-Identität — Agentenregistrierung, Reputations-Scoring und Validierung auf Sepolia mit Identitäts-/Reputations-/Validierungsregistern",
        "🦑 Kraken-CLI-Integration — CLI-Wrapper mit NDJSON-Parsing, Ausführungs-Engine und Pipeline-Signal-Adapter für Kraken-Trading",
        "📊 Dual-Market-Korrelations-Engine — thesenbasiertes Kraken-Mapping, Forex/Futures-Korrelation und konfigurierbarer Dual-Market-Modus",
        "🚀 Multi-Leg-Ausführung — Asset-Klassen-Routing mit konfidenzgewichteter Dimensionierung und SSE-Streaming für Echtzeit-Updates",
        "🎛️ DualMarketPanel UI — animierte Kraken-Leg-Visualisierung im Agenten-Management-Dashboard mit Live-Status-Tracking",
        "📜 Pipeline-Verlauf — aktualisierte Pipeline-Seite mit Kraken-Legs, Wallet-Daten und Ausführungsdetails",
        "🧠 Cross-Market-Intelligenz — universelle Korrelations-Engine, die Polymarket-Vorhersagen mit traditionellen Kraken-Märkten verbindet",
        "✅ ERC-8004 Pipeline-Validierung — On-Chain-Request/Response-Validierungs-Hooks im Agenten-Ausführungsfluss",
      ],
    },
    fixes: {
      en: [
        "🔧 Replaced Postgres stubs with real pgQuery/pgQueryOne calls for full production database support",
        "🧹 Simplified correlation engine and tightened types — removed redundant KrakenLeg duplicates",
        "📡 Fixed DualMarketPanel to use Zustand store instead of Socket.IO for reliable state management",
      ],
      es: [
        "🔧 Reemplazados stubs de Postgres con llamadas reales pgQuery/pgQueryOne para soporte completo de base de datos en producción",
        "🧹 Simplificado motor de correlación y tipos ajustados — eliminados duplicados redundantes de KrakenLeg",
        "📡 Corregido DualMarketPanel para usar Zustand store en vez de Socket.IO para gestión de estado confiable",
      ],
      fr: [
        "🔧 Remplacement des stubs Postgres par de vrais appels pgQuery/pgQueryOne pour le support complet de la base de données en production",
        "🧹 Simplification du moteur de corrélation et renforcement des types — suppression des doublons KrakenLeg redondants",
        "📡 Correction de DualMarketPanel pour utiliser le store Zustand au lieu de Socket.IO pour une gestion d'état fiable",
      ],
      de: [
        "🔧 Postgres-Stubs durch echte pgQuery/pgQueryOne-Aufrufe für vollständige Produktionsdatenbankunterstützung ersetzt",
        "🧹 Korrelations-Engine vereinfacht und Typen verschärft — redundante KrakenLeg-Duplikate entfernt",
        "📡 DualMarketPanel auf Zustand Store statt Socket.IO für zuverlässiges State-Management umgestellt",
      ],
    },
  },
];
