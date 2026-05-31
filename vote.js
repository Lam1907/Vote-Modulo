/**
 * VOTE.JS — Danzad Malditos  v8 (estable)
 * ═══════════════════════════════════════════════════════════════
 *
 * RUTAS FIREBASE — únicas, definitivas, en inglés:
 *   /state          → { votingOpen, votingEnded, waitingRoom,
 *                       currentRound, timerEnd, totalVotes }
 *   /participants   → { participant_1..10: { id, number, name, image } }
 *   /votaciones     → registro de votos (push)
 *   /voteSettings   → textos, fondo, símbolo
 *
 * REGLAS ARQUITECTURALES:
 *   1. showScreen() se llama SOLO desde handleStateChange()
 *      Excepciones explícitas y justificadas:
 *        a) btn-enter → showScreen("waiting")  solo si !votingOpen
 *        b) registrarVoto() → showScreen("done") tras confirmación
 *   2. resetVoteState() limpia TODO al entrar a waitingRoom
 *      o al detectar cambio de currentRound
 *   3. Doble voto: 1 voto por ronda (localStorage rl_lastVoteRound)
 *      Se desbloquea automáticamente cuando cambia currentRound
 *   4. 3 listeners Firebase creados UNA SOLA VEZ en init()
 *      No se recrean al cambiar de pantalla
 *   5. Compatible: GitHub Pages + Wix iframe
 *      Firebase Compat SDK — sin type="module"
 *
 * CORRECCIONES v8:
 *   - handleStateChange: lógica de ronda sin duplicación
 *   - btn-enter: guard para no sobreescribir pantalla si votingOpen
 *   - vote-bg: position:absolute (era fixed — problema en Wix iframe)
 *   - updateBanner: guard para ronda 0 o null
 *
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════
     0. FIREBASE — CONFIG + RUTAS GLOBALES OFICIALES
        Config idéntica al panel de control.
  ═══════════════════════════════════════════════════════ */

  var FIREBASE_CONFIG = {
    apiKey:            "AIzaSyCxd2sdNJZaQ0Rq_mF6Sn1wLQra4Eabp1U",
    authDomain:        "danzad-maldit0s.firebaseapp.com",
    databaseURL:       "https://danzad-maldit0s-default-rtdb.firebaseio.com",
    projectId:         "danzad-maldit0s",
    storageBucket:     "danzad-maldit0s.firebasestorage.app",
    messagingSenderId: "774607843671",
    appId:             "1:774607843671:web:ec64876ba81b6b50acce12"
  };

  /* Rutas Firebase — únicas, definitivas. NO modificar. */
  var DB = {
    STATE:        "state",
    PARTICIPANTS: "participants",
    VOTACIONES:   "votaciones",
    SETTINGS:     "voteSettings"
  };

  firebase.initializeApp(FIREBASE_CONFIG);
  var db = firebase.database();

  console.log("[RL:vote] ✓ Firebase OK →", FIREBASE_CONFIG.databaseURL);
  console.log("[RL:vote] Rutas:", JSON.stringify(DB));

  /* ═══════════════════════════════════════════════════════
     1. CONSTANTES
  ═══════════════════════════════════════════════════════ */

  var PAIR_COLORS = {
    1: { name: "rojo",     hex: "#e03030" },
    2: { name: "amarillo", hex: "#d4aa20" },
    3: { name: "verde",    hex: "#2ea86b" },
    4: { name: "azul",     hex: "#2b7fd4" },
    5: { name: "morado",   hex: "#9b52d4" }
  };

  var TOTAL_PAIRS      = 5;
  var MEMBERS_PER_PAIR = 2;

  /* Claves de localStorage */
  var LS_LAST_ROUND = "rl_lastVoteRound";
  var LS_DEVICE_ID  = "rl_deviceId";

  /* ═══════════════════════════════════════════════════════
     2. ESTADO LOCAL
        Única fuente de verdad de la UI.
        No contiene datos crudos de Firebase — solo copias
        normalizadas para uso interno.
  ═══════════════════════════════════════════════════════ */

  var local = {
    currentPair:    1,
    pairs:          { 1: [], 2: [], 3: [], 4: [], 5: [] },
    participants:   {},     /* copia normalizada de /participants  */
    fbState:        null,   /* último snapshot.val() de /state    */
    lastKnownRound: null    /* para detectar cambio de ronda      */
  };

  /* ═══════════════════════════════════════════════════════
     3. WIX HEIGHT BRIDGE
        Notifica la altura real del contenido al iframe padre.
        Necesario porque Wix no recalcula la altura del iframe.
  ═══════════════════════════════════════════════════════ */

  function notifyHeight() {
    try {
      var h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        900
      );
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "wix-iframe-height", height: h }, "*");
        window.parent.postMessage(JSON.stringify({ type: "height", value: h }), "*");
      }
    } catch (e) { /* silencioso — sin parent válido */ }
  }

  window.addEventListener("load",   notifyHeight);
  window.addEventListener("resize", notifyHeight);
  setInterval(notifyHeight, 1000);

  /* ═══════════════════════════════════════════════════════
     4. SISTEMA DE PANTALLAS
        showScreen() es llamada SOLO desde handleStateChange().
        Excepciones documentadas en la cabecera del archivo.
  ═══════════════════════════════════════════════════════ */

  var SCREENS = {
    menu:         $("screen-menu"),
    waiting:      $("screen-waiting"),
    vote:         $("screen-vote"),
    done:         $("screen-done"),
    ended:        $("screen-ended"),
    alreadyVoted: $("screen-already-voted")
  };

  function showScreen(name) {
    console.log("[RL:vote] Screen →", name);
    Object.keys(SCREENS).forEach(function (key) {
      var el = SCREENS[key];
      if (!el) return;
      if (key === name) {
        el.classList.add("active");
        /* Double rAF: display:block primero, luego opacity transition */
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            el.classList.add("visible");
          });
        });
      } else {
        el.classList.remove("active", "visible");
      }
    });
    /* Notificar nueva altura a Wix tras cambio de pantalla */
    setTimeout(notifyHeight, 60);
    setTimeout(notifyHeight, 420);
  }

  /* ═══════════════════════════════════════════════════════
     5. DOBLE VOTO — POR RONDA (no permanente)
        Regla: 1 dispositivo = 1 voto por ronda.
        Cuando currentRound cambia → se puede votar de nuevo.
  ═══════════════════════════════════════════════════════ */

  function getDeviceId() {
    try {
      var id = localStorage.getItem(LS_DEVICE_ID);
      if (!id) {
        id = "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(LS_DEVICE_ID, id);
      }
      return id;
    } catch (e) { return "dev_unknown"; }
  }

  function getLastVoteRound() {
    try { return parseInt(localStorage.getItem(LS_LAST_ROUND) || "0", 10); }
    catch (e) { return 0; }
  }

  function setLastVoteRound(round) {
    try { localStorage.setItem(LS_LAST_ROUND, String(round)); }
    catch (e) { /* silencioso */ }
  }

  function hasVotedThisRound(round) {
    return getLastVoteRound() === parseInt(round, 10);
  }

  /* ═══════════════════════════════════════════════════════
     6. RESET COMPLETO DE ESTADO LOCAL
        Limpia: pares, selecciones, visuales, contadores.
        Se ejecuta automáticamente en:
          - waitingRoom === true
          - cambio de currentRound
  ═══════════════════════════════════════════════════════ */

  function resetVoteState() {
    console.log("[RL:vote] resetVoteState() — limpiando selección completa");

    local.currentPair = 1;
    local.pairs = { 1: [], 2: [], 3: [], 4: [], 5: [] };

    /* Limpiar clases visuales de todas las tarjetas */
    document.querySelectorAll(".participant-card").forEach(function (card) {
      card.classList.remove(
        "selected", "paired", "locked",
        "pair-1", "pair-2", "pair-3", "pair-4", "pair-5"
      );
      var badge = card.querySelector(".card-pair-badge");
      if (badge) {
        badge.textContent      = "";
        badge.style.background = "";
        badge.style.color      = "";
      }
    });

    /* Actualizar indicadores de UI */
    updateIndicator();
    updateSubmitBtn();
    updateBanner();
  }

  /* ═══════════════════════════════════════════════════════
     7. LISTENER CENTRAL — /state
        Crea el listener UNA SOLA VEZ.
        Toda lógica de pantalla vive en handleStateChange().
  ═══════════════════════════════════════════════════════ */

  function listenState() {
    console.log("[RL:vote] Listener activo → /state");

    db.ref(DB.STATE).on("value", function (snap) {
      var s = snap.val();
      console.log("[RL:vote] /state →", JSON.stringify(s));

      if (!s) {
        console.log("[RL:vote] /state vacío → menu");
        showScreen("menu");
        return;
      }

      handleStateChange(s);
    });
  }

  /**
   * Procesa el snapshot de /state y decide:
   * 1. Si cambió la ronda → resetVoteState()
   * 2. Qué pantalla mostrar según los flags
   *
   * PRIORIDAD de flags:
   *   votingEnded > votingOpen > waitingRoom > (neutro → menu)
   *
   * @param {Object} s - snapshot.val() de /state
   */
  function handleStateChange(s) {
    var currRound = parseInt(s.currentRound || 1, 10);
    var prevRound = local.lastKnownRound;

    /* ── Detectar cambio de ronda ─────────────────────────
       Solo resets si ya teníamos una ronda previa
       (null significa primera carga — no hay ronda anterior)
    ──────────────────────────────────────────────────── */
    if (prevRound !== null && prevRound !== currRound) {
      console.log("[RL:vote] Cambio de ronda:", prevRound, "→", currRound);
      resetVoteState();
    }

    /* Guardar estado actual como referencia */
    local.fbState        = s;
    local.lastKnownRound = currRound;

    /* ── Prioridad de pantallas ──────────────────────────
       votingEnded: máxima prioridad — cierra cualquier otra vista
       votingOpen:  mostrar votación (o ya-votaste si ya votó)
       waitingRoom: sala de espera + reset de selección
       default:     menú
    ──────────────────────────────────────────────────── */

    if (s.votingEnded === true) {
      console.log("[RL:vote] votingEnded=true → ended");
      showScreen("ended");
      return;
    }

    if (s.votingOpen === true) {
      if (hasVotedThisRound(currRound)) {
        console.log("[RL:vote] votingOpen + ya votó ronda", currRound, "→ alreadyVoted");
        showScreen("alreadyVoted");
        return;
      }
      console.log("[RL:vote] votingOpen=true → vote");
      showScreen("vote");
      /* Renderizar participantes si el grid aún no tiene tarjetas */
      var grid = $("participants-grid");
      if (grid && grid.children.length <= 1) {
        renderGrid();
      }
      return;
    }

    if (s.waitingRoom === true) {
      console.log("[RL:vote] waitingRoom=true → waiting + reset");
      resetVoteState();   /* limpiar selección al entrar a sala de espera */
      showScreen("waiting");
      return;
    }

    /* Todos los flags en false → menú */
    console.log("[RL:vote] Estado neutro → menu");
    showScreen("menu");
  }

  /* ═══════════════════════════════════════════════════════
     8. LISTENER — /participants
        Reactivo: re-renderiza automáticamente si la pantalla
        de votación está activa.
        Estructura oficial: { participant_N: { id, number, name, image } }
  ═══════════════════════════════════════════════════════ */

  function listenParticipants() {
    console.log("[RL:vote] Listener activo → /participants");

    db.ref(DB.PARTICIPANTS).on("value", function (snap) {
      var data  = snap.val();
      var count = data ? Object.keys(data).length : 0;
      console.log("[RL:vote] /participants →", count, "registros");

      /* Debug — muestra estructura del primer participante */
      if (data) {
        var fk = Object.keys(data)[0];
        if (fk) {
          var fp = data[fk];
          console.log("[RL:vote] Ejemplo →",
            "key:", fk,
            "| name:", fp.name || "(sin name)",
            "| number:", fp.number || "(sin number)",
            "| image:", fp.image ? fp.image.substring(0, 40) + "…" : "(sin imagen)"
          );
        }
      }

      local.participants = data || {};

      /* Re-renderizar en tiempo real si estamos en pantalla de votación */
      if (SCREENS.vote && SCREENS.vote.classList.contains("active")) {
        renderGrid();
        notifyHeight();
      }
    });
  }

  /* ═══════════════════════════════════════════════════════
     9. LISTENER — /voteSettings
        Textos, fondo menú, símbolo sala de espera.
        Preparado para editor futuro.
  ═══════════════════════════════════════════════════════ */

  function listenSettings() {
    console.log("[RL:vote] Listener activo → /voteSettings");

    db.ref(DB.SETTINGS).on("value", function (snap) {
      var s = snap.val();
      if (!s) return;
      applySettings(s);
    });
  }

  function applySettings(s) {
    /* Fondo del menú — inyección de CSS custom property */
    if (s.menuBackground) {
      var menuEl = $("screen-menu");
      if (menuEl) {
        menuEl.style.setProperty("--menu-bg-url", "url(\"" + s.menuBackground + "\")");
      }
    }

    /* Símbolo sala de espera — reemplaza SVG del caballo */
    if (s.waitingSymbol) {
      var core = $("waiting-symbol-core");
      if (core) {
        core.innerHTML =
          "<img src=\"" + s.waitingSymbol +
          "\" alt=\"Símbolo\" style=\"width:100%;height:100%;object-fit:contain;\" />";
        /* La animación horse-trot se aplica automáticamente via CSS a .symbol-core img */
      }
    }

    /* Textos dinámicos */
    var t = s.texts || {};
    setTxt("text-menu-line1",          t.menuLine1);
    setTxt("text-menu-line2",          t.menuLine2);
    setTxt("text-menu-note",           t.menuNote);
    setHTML("text-waiting-title",      t.waitingTitle);
    setTxt("text-waiting-message",     t.waitingMessage);
    setHTML("text-waiting-signature",  t.waitingSignature);
  }

  /* ═══════════════════════════════════════════════════════
     10. RENDER — GRID DE PARTICIPANTES
         Construye tarjetas desde local.participants.
         Preserva selecciones activas al re-renderizar.
  ═══════════════════════════════════════════════════════ */

  function renderGrid() {
    var grid = $("participants-grid");
    if (!grid) return;

    var list = normalizeParticipants(local.participants);

    if (list.length === 0) {
      console.warn("[RL:vote] /participants vacío — usando fallback");
      list = fallbackParticipants();
    }

    /* Ordenar por número de participante */
    list.sort(function (a, b) { return a.number - b.number; });

    /* Reconstruir tarjetas */
    grid.innerHTML = "";
    list.forEach(function (p, i) {
      grid.appendChild(makeCard(p, i));
    });

    /* Restaurar visuals si había selecciones activas */
    restoreVisuals();
    updateIndicator();
    updateSubmitBtn();
    updateBanner();

    setTimeout(notifyHeight, 200);
    console.log("[RL:vote] Grid →", list.length, "tarjetas renderizadas");
  }

  /**
   * Normaliza el objeto de Firebase al formato interno.
   * Compatible con los campos reales del panel de control:
   *   name, image, number (en inglés)
   * Mantiene compatibilidad con variantes: nombre, imagen, numero
   */
  function normalizeParticipants(obj) {
    if (!obj) return [];
    return Object.keys(obj).map(function (key) {
      var p = obj[key];
      return {
        id:     key,                                       /* participant_1, participant_2... */
        number: parseInt(p.number || p.numero || 0, 10),  /* número de participante         */
        name:   p.name   || p.nombre || key,               /* nombre visible en tarjeta      */
        image:  p.image  || p.imagen || ""                 /* base64 o URL (puede ser vacío) */
      };
    });
  }

  /**
   * Crea el DOM de una tarjeta.
   * IMPORTANTE — imágenes base64:
   *   - NO aplicar escHtml() al src → corrompería el string base64
   *   - NO usar loading="lazy"       → falla en móviles con base64
   */
  function makeCard(p, i) {
    var card = document.createElement("div");
    card.className = "participant-card";
    card.setAttribute("data-id", p.id);
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-label", "Participante " + p.number + ": " + p.name);
    card.style.animation =
      "card-appear 0.4s cubic-bezier(0.22,1,0.36,1) " + (i * 45) + "ms both";

    var isBase64  = p.image && p.image.indexOf("data:") === 0;
    var imgHTML   = p.image
      ? ("<img src=\"" + p.image + "\" alt=\"" + escHtml(p.name) + "\"" +
         (isBase64 ? "" : " loading=\"lazy\"") + " />")
      : placeholderSVG(p.name);

    card.innerHTML =
      "<div class=\"card-image-wrap\">" +
        imgHTML +
        "<div class=\"card-overlay\"></div>" +
        "<div class=\"card-num\">#" + pad(p.number) + "</div>" +
        "<div class=\"card-pair-badge\"></div>" +
      "</div>" +
      "<div class=\"card-info\">" +
        "<span class=\"card-name\">" + escHtml(p.name) + "</span>" +
      "</div>";

    card.addEventListener("click", function () { handleClick(p.id); });
    return card;
  }

  /** Placeholder SVG con iniciales — sin dependencias externas */
  function placeholderSVG(name) {
    var initials = (name || "?")
      .split(" ").slice(0, 2)
      .map(function (w) { return w[0] || ""; })
      .join("").toUpperCase();

    return "<div class=\"card-placeholder\">" +
      "<svg viewBox=\"0 0 80 80\" xmlns=\"http://www.w3.org/2000/svg\">" +
        "<rect width=\"80\" height=\"80\" fill=\"#1e1916\"/>" +
        "<text x=\"40\" y=\"47\" text-anchor=\"middle\" " +
          "font-family=\"'Bebas Neue',sans-serif\" font-size=\"28\" " +
          "fill=\"rgba(200,169,110,0.45)\" letter-spacing=\"2\">" +
          initials +
        "</text>" +
      "</svg>" +
    "</div>";
  }

  /** Participantes de ejemplo cuando /participants está vacío */
  function fallbackParticipants() {
    return [
      "Ana Reyes","Camilo Torres","Sofia Díaz","Mateo Ruiz",
      "Valentina Cruz","Sebastián López","Isabella Mora",
      "Daniel García","Luciana Vargas","Alejandro Ríos"
    ].map(function (n, i) {
      return { id: "participant_" + (i + 1), number: i + 1, name: n, image: "" };
    });
  }

  /* ═══════════════════════════════════════════════════════
     11. LÓGICA DE SELECCIÓN DE PAREJAS
  ═══════════════════════════════════════════════════════ */

  function handleClick(id) {
    /* Bloquear si votingOpen = false */
    if (!local.fbState || !local.fbState.votingOpen) {
      console.warn("[RL:vote] Clic bloqueado — votingOpen=false");
      return;
    }

    var inPair = findPair(id);

    /* Ya en una pareja completa → quitar */
    if (inPair !== null) { removeFromPair(id, inPair); return; }

    /* Es el primer seleccionado de la pareja actual → cancelar */
    if (isPending(id)) { cancelPending(id); return; }

    /* Pareja actual llena → buscar la siguiente incompleta */
    if (local.pairs[local.currentPair].length >= MEMBERS_PER_PAIR) {
      var inc = findIncomplete();
      if (inc === null) return; /* todas completas */
      local.currentPair = inc;
    }

    addToPair(id);
  }

  function findPair(id) {
    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      if (local.pairs[p].indexOf(id) !== -1) return p;
    }
    return null;
  }

  function isPending(id) {
    var arr = local.pairs[local.currentPair];
    return arr.length === 1 && arr[0] === id;
  }

  function cancelPending(id) {
    local.pairs[local.currentPair] = [];
    setCardVisual(id, "none");
    updateIndicator();
    updateBanner();
  }

  function removeFromPair(id, pairNum) {
    local.pairs[pairNum] = local.pairs[pairNum].filter(function (x) {
      return x !== id;
    });
    setCardVisual(id, "none");

    /* Si queda 1 miembro, vuelve a estado "pending" */
    var rem = local.pairs[pairNum];
    if (rem.length === 1) setCardVisual(rem[0], "selected", pairNum);

    /* Apuntar a la primera pareja incompleta */
    var inc = findIncomplete();
    if (inc !== null) local.currentPair = inc;

    updateIndicator();
    updateSubmitBtn();
    updateBanner();
  }

  function addToPair(id) {
    local.pairs[local.currentPair].push(id);
    var count = local.pairs[local.currentPair].length;

    if (count === 1) {
      /* Primera selección → borde blanco brillante + pulso */
      setCardVisual(id, "selected", local.currentPair);

    } else if (count === MEMBERS_PER_PAIR) {
      /* Segunda selección → pareja completa → color */
      var m = local.pairs[local.currentPair];
      setCardVisual(m[0], "paired", local.currentPair);
      setCardVisual(m[1], "paired", local.currentPair);

      /* Avanzar a la siguiente pareja incompleta */
      var next = findNextIncomplete(local.currentPair);
      if (next !== null) local.currentPair = next;
    }

    updateIndicator();
    updateSubmitBtn();
    updateBanner();
  }

  function findIncomplete() {
    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      if (local.pairs[p].length < MEMBERS_PER_PAIR) return p;
    }
    return null;
  }

  function findNextIncomplete(after) {
    for (var p = after + 1; p <= TOTAL_PAIRS; p++) {
      if (local.pairs[p].length < MEMBERS_PER_PAIR) return p;
    }
    for (var q = 1; q <= after; q++) {
      if (local.pairs[q].length < MEMBERS_PER_PAIR) return q;
    }
    return null;
  }

  /* ═══════════════════════════════════════════════════════
     12. VISUALES DE TARJETAS
  ═══════════════════════════════════════════════════════ */

  function setCardVisual(id, status, pairNum) {
    var card = document.querySelector(".participant-card[data-id=\"" + id + "\"]");
    if (!card) return;

    var badge = card.querySelector(".card-pair-badge");

    /* Limpiar todo primero */
    card.classList.remove(
      "selected", "paired", "locked",
      "pair-1", "pair-2", "pair-3", "pair-4", "pair-5"
    );
    badge.textContent      = "";
    badge.style.background = "";
    badge.style.color      = "";

    if (status === "none") return;

    if (status === "selected") {
      card.classList.add("selected");
      badge.textContent      = String(pairNum || local.currentPair);
      badge.style.background = "rgba(255,255,255,0.35)";
      badge.style.color      = "#fff";
      return;
    }

    if (status === "paired" && pairNum) {
      card.classList.add("paired", "pair-" + pairNum);
      badge.textContent      = String(pairNum);
      badge.style.background = PAIR_COLORS[pairNum].hex;
      badge.style.color      = pairNum === 2 ? "#111" : "#fff";
    }
  }

  /** Restaura los visuales de tarjetas tras re-render del grid */
  function restoreVisuals() {
    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      var m = local.pairs[p];
      if (m.length === 2) {
        setCardVisual(m[0], "paired", p);
        setCardVisual(m[1], "paired", p);
      } else if (m.length === 1) {
        setCardVisual(m[0], "selected", p);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════
     13. BANNER — PAREJA ACTIVA
         v8: guard para currentPair fuera de rango
  ═══════════════════════════════════════════════════════ */

  function updateBanner() {
    var banner = $("active-pair-banner");
    var dot    = $("apb-dot");
    var text   = $("apb-text");
    if (!banner || !dot || !text) return;

    if (allComplete()) {
      banner.style.background  = "rgba(200,169,110,0.12)";
      banner.style.borderColor = "rgba(200,169,110,0.35)";
      dot.style.background     = "#c8a96e";
      text.innerHTML           = "¡Todas las parejas listas!";
      return;
    }

    var p = local.currentPair;
    /* Guard: si p no está en PAIR_COLORS (ej. 0 o >5) usar 1 */
    if (!PAIR_COLORS[p]) p = 1;

    var c       = PAIR_COLORS[p];
    var members = local.pairs[p] ? local.pairs[p].length : 0;

    banner.style.background  = c.hex + "12";
    banner.style.borderColor = c.hex + "40";
    dot.style.background     = c.hex;

    text.innerHTML = members === 0
      ? "Formando <strong>Pareja " + p + "</strong> &mdash; elige el 1er participante"
      : "Formando <strong>Pareja " + p + "</strong> &mdash; elige el 2do participante";
  }

  /* ═══════════════════════════════════════════════════════
     14. INDICADOR DE PAREJAS — PILLS
  ═══════════════════════════════════════════════════════ */

  function updateIndicator() {
    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      var pill  = document.querySelector(".pair-pill[data-pair=\"" + p + "\"]");
      var count = $("count-" + p);
      if (!pill || !count) continue;

      var members = local.pairs[p] ? local.pairs[p].length : 0;
      count.textContent = members + "/2";
      pill.classList.remove("active", "complete");

      if (members === MEMBERS_PER_PAIR) {
        pill.classList.add("complete");
      } else if (p === local.currentPair) {
        pill.classList.add("active");
      }
    }
  }

  /* ═══════════════════════════════════════════════════════
     15. BOTÓN REGISTRAR VOTO
  ═══════════════════════════════════════════════════════ */

  function updateSubmitBtn() {
    var btn  = $("btn-register");
    var info = $("vote-progress-text");
    if (!btn || !info) return;

    var done = allComplete();
    btn.disabled = !done;

    if (done) {
      info.textContent = "¡Tus 5 parejas están listas!";
    } else {
      var rem = TOTAL_PAIRS - completePairs();
      info.textContent = rem === 1
        ? "Falta 1 pareja por completar"
        : "Faltan " + rem + " parejas por completar";
    }
  }

  function allComplete() {
    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      if (!local.pairs[p] || local.pairs[p].length < MEMBERS_PER_PAIR) return false;
    }
    return true;
  }

  function completePairs() {
    var n = 0;
    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      if (local.pairs[p] && local.pairs[p].length === MEMBERS_PER_PAIR) n++;
    }
    return n;
  }

  /* ═══════════════════════════════════════════════════════
     16. MODAL DE CONFIRMACIÓN
         Muestra los NOMBRES REALES de cada participante.
         No IDs ni números internos.
  ═══════════════════════════════════════════════════════ */

  function openModal() {
    var summary = $("modal-pairs-summary");
    if (!summary) return;
    summary.innerHTML = "";

    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      var ids   = local.pairs[p] || [];
      var c     = PAIR_COLORS[p];
      var name1 = getNameById(ids[0]);
      var name2 = getNameById(ids[1]);

      var row = document.createElement("div");
      row.className        = "summary-row";
      row.style.background = c.hex + "14";
      row.style.border     = "1px solid " + c.hex + "40";
      row.innerHTML =
        "<div class=\"summary-badge\" style=\"background:" + c.hex +
          (p === 2 ? ";color:#111" : "") + "\">" + p + "</div>" +
        "<span class=\"summary-names\">" +
          escHtml(name1) +
          " <span class=\"summary-vs\">con</span> " +
          escHtml(name2) +
        "</span>";

      summary.appendChild(row);
    }

    $("modal-confirm").classList.add("open");
    notifyHeight();
  }

  function closeModal() {
    var modal = $("modal-confirm");
    if (modal) modal.classList.remove("open");
    notifyHeight();
  }

  /**
   * Obtiene el nombre de un participante por su ID.
   * Acceso directo por key (participant_1, participant_2...).
   * Fallback: búsqueda por campo id interno.
   */
  function getNameById(id) {
    if (!id) return "—";

    /* Acceso directo por key de Firebase */
    var p = local.participants[id];
    if (p) return p.name || p.nombre || id;

    /* Búsqueda secundaria por campo id interno */
    var keys = Object.keys(local.participants);
    for (var i = 0; i < keys.length; i++) {
      var item = local.participants[keys[i]];
      if (String(item.id || keys[i]) === String(id)) {
        return item.name || item.nombre || id;
      }
    }

    return id; /* último fallback: devolver el ID */
  }

  /* ═══════════════════════════════════════════════════════
     17. REGISTRO DE VOTO — escribe en /votaciones
  ═══════════════════════════════════════════════════════ */

  function registrarVoto() {
    /* Verificar que la votación sigue abierta */
    if (!local.fbState || !local.fbState.votingOpen) {
      console.warn("[RL:vote] Voto rechazado — votingOpen=false");
      closeModal();
      return;
    }

    var currRound = parseInt(
      (local.fbState && local.fbState.currentRound) || 1, 10
    );

    /* Verificar doble voto en esta ronda */
    if (hasVotedThisRound(currRound)) {
      console.warn("[RL:vote] Ya votó en ronda", currRound);
      closeModal();
      showScreen("alreadyVoted");
      return;
    }

    var payload = buildPayload(currRound);
    console.log("[RL:vote] Enviando voto → /votaciones ronda:", currRound);

    db.ref(DB.VOTACIONES).push(payload)
      .then(function () {
        console.log("[RL:vote] ✓ Voto registrado en /votaciones");
        setLastVoteRound(currRound); /* bloquear esta ronda en este dispositivo */
        closeModal();
        /* Excepción permitida: confirmación de acción de usuario */
        showScreen("done");
      })
      .catch(function (err) {
        console.error("[RL:vote] Error al registrar:", err);
        closeModal();
        alert("Error al registrar el voto. Por favor intenta de nuevo.");
      });
  }

  /**
   * Construye el payload para /votaciones.
   * Estructura limpia — usable por broadcast, panel y resultados.
   */
  function buildPayload(round) {
    var parejas = {};

    for (var p = 1; p <= TOTAL_PAIRS; p++) {
      var ids = local.pairs[p] || [];
      var c   = PAIR_COLORS[p];
      parejas["pareja_" + p] = {
        numero: p,
        color:  c.name,
        participantes: ids.map(function (id) {
          return { id: id, nombre: getNameById(id) };
        })
      };
    }

    return {
      timestamp:    Date.now(),
      fechaISO:     new Date().toISOString(),
      round:        round,
      deviceId:     getDeviceId(),
      parejas:      parejas,
      totalParejas: TOTAL_PAIRS
    };
  }

  /* ═══════════════════════════════════════════════════════
     18. EVENTOS DE INTERFAZ
  ═══════════════════════════════════════════════════════ */

  function bindEvents() {
    /*
     * btn-enter (menú → sala de espera)
     * EXCEPCIÓN a la regla de showScreen():
     * Solo lleva a waiting si Firebase NO tiene votingOpen=true.
     * Si ya está abierta la votación, muestra la votación directamente.
     */
    on("btn-enter", "click", function () {
      if (local.fbState && local.fbState.votingOpen === true) {
        /* La votación ya está abierta — ir directo a vote */
        console.log("[RL:vote] btn-enter → votingOpen=true → vote");
        if (hasVotedThisRound((local.fbState.currentRound || 1))) {
          showScreen("alreadyVoted");
        } else {
          showScreen("vote");
          var grid = $("participants-grid");
          if (grid && grid.children.length <= 1) renderGrid();
        }
      } else {
        /* Ir a sala de espera — Firebase controlará el resto */
        console.log("[RL:vote] btn-enter → waiting");
        showScreen("waiting");
      }
    });

    /* Botón registrar voto */
    on("btn-register", "click", function () {
      if (allComplete()) openModal();
    });

    /* Modal — No, editar */
    on("modal-no", "click", closeModal);

    /* Modal — Sí, confirmar */
    on("modal-yes", "click", registrarVoto);

    /* Cerrar modal al clic en overlay (fuera del box) */
    var overlay = $("modal-confirm");
    if (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeModal();
      });
    }

    /* Botón ↺ Reiniciar selección (solo limpia UI, no cambia pantalla) */
    on("btn-back-from-vote", "click", function () {
      resetVoteState();
      console.log("[RL:vote] Selección reiniciada por usuario");
    });
  }

  /* ═══════════════════════════════════════════════════════
     19. INICIALIZACIÓN
  ═══════════════════════════════════════════════════════ */

  function init() {
    console.log("[RL:vote] ═══════════ Iniciando v8 ═══════════");
    console.log("[RL:vote] deviceId:", getDeviceId());
    console.log("[RL:vote] lastVoteRound:", getLastVoteRound());

    /* 1. Eventos de UI — siempre se inicializan */
    bindEvents();

    /*
     * 2. Los 3 listeners Firebase — creados UNA SOLA VEZ aquí.
     *    NO se recrean al cambiar de pantalla.
     *    /state controla TODAS las transiciones visuales del sistema.
     */
    listenState();        /* /state         → pantallas + reset por ronda */
    listenParticipants(); /* /participants   → grid de tarjetas reactivo  */
    listenSettings();     /* /voteSettings  → textos, fondo, símbolo      */

    console.log("[RL:vote] ✓ 3 listeners Firebase activos");
    console.log("[RL:vote] Escuchando:", DB.STATE, "|", DB.PARTICIPANTS, "|", DB.SETTINGS);
  }

  /* ═══════════════════════════════════════════════════════
     UTILIDADES INTERNAS
  ═══════════════════════════════════════════════════════ */

  function $(id)          { return document.getElementById(id); }
  function pad(n)         { return String(n || 0).padStart(2, "0"); }
  function on(id, ev, fn) { var e = $(id); if (e) e.addEventListener(ev, fn); }
  function setTxt(id, v)  { if (!v) return; var e = $(id); if (e) e.textContent = v; }
  function setHTML(id, v) { if (!v) return; var e = $(id); if (e) e.innerHTML    = v; }
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g,  "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;");
  }

  /* ── Arrancar cuando el DOM esté listo ── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})(); /* fin IIFE */
