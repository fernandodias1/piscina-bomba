// ============================================================
// Piscina — app de acompanhamento via MQTT (PWA)
// ============================================================
// Fala diretamente com o mesmo broker MQTT que o firmware usa, via
// MQTT-sobre-WebSocket (por isso a URL de conexão começa com wss://,
// numa porta diferente da 8883 usada pelo ESP32). Todo o estado mostrado
// aqui vem de mensagens retidas (retain) nos mesmos tópicos que o
// firmware já publica/assina — nada é inventado ou calculado aqui.

const CONFIG_KEY = "piscina_config";
const CACHE_KEY = "piscina_last_values";

const els = {
  overlay: document.getElementById("overlay"),
  connectForm: document.getElementById("connect-form"),
  connectError: document.getElementById("connect-error"),
  connectBack: document.getElementById("connect-back"),
  fUrl: document.getElementById("f-url"),
  fUser: document.getElementById("f-user"),
  fPass: document.getElementById("f-pass"),
  fTopic: document.getElementById("f-topic"),

  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  settingsBtn: document.getElementById("settings-btn"),

  tempValue: document.getElementById("temp-value"),
  tempUpdated: document.getElementById("temp-updated"),
  pumpPill: document.getElementById("pump-pill"),
  pumpPillText: document.getElementById("pump-pill-text"),
  timeToday: document.getElementById("time-today-value"),
  sunTimeline: document.getElementById("sun-timeline"),

  autoSwitch: document.getElementById("auto-switch"),
  manualBtn: document.getElementById("manual-btn"),
  manualSublabel: document.getElementById("manual-sublabel"),

  advancedToggle: document.getElementById("advanced-toggle"),
  advancedBody: document.getElementById("advanced-body"),
  meteoSwitch: document.getElementById("meteo-switch"),
  cfgTempRef: document.getElementById("cfg-temp-ref"),
  cfgTempoRef: document.getElementById("cfg-tempo-ref"),
  cfgMaxDia: document.getElementById("cfg-max-dia"),
  cfgMinDia: document.getElementById("cfg-min-dia"),
  cfgLat: document.getElementById("cfg-lat"),
  cfgLon: document.getElementById("cfg-lon"),
  saveConfigBtn: document.getElementById("save-config"),
};

let client = null;
let topicPrefix = "";
let state = {
  automatico: null,
  estado_bomba: null,
  horas: [], // horas do dia (0-23) com maior radiação
};

// ---------------- Configuração salva no navegador ----------------

function loadSavedConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveCacheValue(suffix, payload) {
  const cache = loadCache();
  cache[suffix] = payload;
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

// ---------------- Tela de conexão ----------------

function openOverlay(prefill) {
  if (prefill) {
    els.fUrl.value = prefill.url || "";
    els.fUser.value = prefill.username || "";
    els.fPass.value = prefill.password || "";
    els.fTopic.value = prefill.topicPrefix || "";
    els.connectBack.style.display = "block";
  } else {
    els.connectBack.style.display = "none";
  }
  els.connectError.textContent = "";
  els.overlay.classList.remove("hidden");
}

function closeOverlay() {
  els.overlay.classList.add("hidden");
}

els.connectBack.addEventListener("click", () => {
  closeOverlay();
});

els.settingsBtn.addEventListener("click", () => {
  openOverlay(loadSavedConfig());
});

els.connectForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const cfg = {
    url: els.fUrl.value.trim(),
    username: els.fUser.value.trim(),
    password: els.fPass.value,
    topicPrefix: els.fTopic.value.trim().replace(/\/+$/, ""),
  };
  saveConfig(cfg);
  closeOverlay();
  connect(cfg);
});

// ---------------- Conexão MQTT ----------------

function setStatus(kind) {
  els.statusDot.className = "status-dot " + (kind === "online" ? "online" : kind === "connecting" ? "connecting" : "");
  els.statusText.textContent = kind === "online" ? "conectado" : kind === "connecting" ? "conectando…" : "desconectado";
}

function connect(cfg) {
  if (client) {
    try {
      client.end(true);
    } catch (e) {
      /* ignora */
    }
  }

  confirmedThisSession = new Set(); // nova sessão, ninguém foi confirmado ainda
  topicPrefix = cfg.topicPrefix;
  setStatus("connecting");

  client = mqtt.connect(cfg.url, {
    username: cfg.username,
    password: cfg.password,
    clientId: "pwa-piscina-" + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 4000,
    connectTimeout: 8000,
    clean: true,
  });

  client.on("connect", () => {
    setStatus("online");
    els.connectError.textContent = "";
    console.log("[piscina] conectado. Assinando:", topicPrefix + "/#");
    client.subscribe(topicPrefix + "/#", { qos: 1 }, (err, granted) => {
      if (err) {
        console.error("[piscina] falha ao assinar tópicos:", err);
        showToast("Falha ao assinar tópicos: " + err.message);
      } else {
        console.log("[piscina] inscrição confirmada pelo broker:", granted);
      }
    });
  });

  client.on("reconnect", () => setStatus("connecting"));
  client.on("close", () => setStatus("offline"));
  client.on("offline", () => setStatus("offline"));

  client.on("error", (err) => {
    console.error("[piscina] erro de conexão:", err);
    setStatus("offline");
    if (!els.overlay.classList.contains("hidden")) {
      els.connectError.textContent = "Não foi possível conectar: " + (err && err.message ? err.message : err);
    }
  });

  client.on("message", (topic, payloadBuf) => {
    const suffix = topic.slice(topicPrefix.length + 1);
    const payload = payloadBuf.toString();
    console.log("[piscina] mensagem recebida:", topic, "=", payload);
    saveCacheValue(suffix, payload);
    confirmedThisSession.add(suffix);
    applyValue(suffix, payload, true);
  });
}

// Tópicos que o firmware só ASSINA (nunca publica de volta). Pra esses,
// a única forma de existir uma mensagem retida é algum app já ter
// publicado antes -- então, enquanto não chega uma mensagem AO VIVO
// nessa sessão, o valor mostrado pode ser só um resquício do cache local
// do navegador, sem garantia nenhuma de que reflete o que o dispositivo
// está usando de verdade agora.
const TOPICOS_SO_COMANDO = new Set([
  "automatico",
  "auxilio_meteorologia",
  "temperatura_referencia_tem_sol",
  "tempo_referencia_tem_sol",
  "tempo_maximo_ligado_dia",
  "tempo_minimo_ligado_dia",
  "latitude",
  "longitude",
]);
let confirmedThisSession = new Set();

function marcarConfirmacao(el, suffix, live) {
  if (!TOPICOS_SO_COMANDO.has(suffix)) return; // os demais o firmware já reconfirma sozinho com frequência
  const confirmado = live || confirmedThisSession.has(suffix);
  el.classList.toggle("unconfirmed", !confirmado);
}

// ---------------- Aplicar valor recebido (ou do cache) na tela ----------------
// "live" = true quando a mensagem chegou agora do broker; false quando é
// uma repetição do cache local, lida antes mesmo de conectar.

function applyValue(suffix, payload, live) {
  switch (suffix) {
    case "temperatura_sensor":
      els.tempValue.textContent = Number(payload).toFixed(1);
      break;
    case "hora_temperatura_sensor":
      els.tempUpdated.textContent = "atualizado às " + payload;
      break;
    case "estado_bomba": {
      const ligada = payload === "1";
      state.estado_bomba = ligada;
      els.pumpPill.classList.toggle("on", ligada);
      els.pumpPillText.textContent = ligada ? "ligada" : "desligada";
      els.manualBtn.textContent = ligada ? "Desligar" : "Ligar";
      els.manualBtn.classList.toggle("on", ligada);
      break;
    }
    case "tempo_bomba_ligada_dia":
      els.timeToday.textContent = payload + " min";
      break;
    case "horas_maior_radiacao_solar": {
      const antesDoTraco = payload.split(" - ")[0];
      state.horas = antesDoTraco
        .split(",")
        .map((h) => parseInt(h.trim(), 10))
        .filter((h) => !isNaN(h) && h >= 0 && h <= 23);
      renderSunTimeline();
      break;
    }
    case "automatico": {
      const on = payload === "1";
      state.automatico = on;
      els.autoSwitch.classList.toggle("on", on);
      els.autoSwitch.setAttribute("aria-checked", String(on));
      marcarConfirmacao(els.autoSwitch, suffix, live);
      updateManualAvailability();
      break;
    }
    case "auxilio_meteorologia": {
      const on = payload === "1";
      els.meteoSwitch.classList.toggle("on", on);
      els.meteoSwitch.setAttribute("aria-checked", String(on));
      marcarConfirmacao(els.meteoSwitch, suffix, live);
      break;
    }
    case "temperatura_referencia_tem_sol":
      if (document.activeElement !== els.cfgTempRef) els.cfgTempRef.value = payload;
      marcarConfirmacao(els.cfgTempRef, suffix, live);
      break;
    case "tempo_referencia_tem_sol":
      if (document.activeElement !== els.cfgTempoRef) els.cfgTempoRef.value = payload;
      marcarConfirmacao(els.cfgTempoRef, suffix, live);
      break;
    case "tempo_maximo_ligado_dia":
      if (document.activeElement !== els.cfgMaxDia) els.cfgMaxDia.value = payload;
      marcarConfirmacao(els.cfgMaxDia, suffix, live);
      break;
    case "tempo_minimo_ligado_dia":
      if (document.activeElement !== els.cfgMinDia) els.cfgMinDia.value = payload;
      marcarConfirmacao(els.cfgMinDia, suffix, live);
      break;
    case "latitude":
      if (document.activeElement !== els.cfgLat) els.cfgLat.value = payload;
      marcarConfirmacao(els.cfgLat, suffix, live);
      break;
    case "longitude":
      if (document.activeElement !== els.cfgLon) els.cfgLon.value = payload;
      marcarConfirmacao(els.cfgLon, suffix, live);
      break;
    default:
      break; // tópico informativo que não temos campo dedicado — ignora
  }
}

// ---------------- Linha do sol (24 barras) ----------------

function renderSunTimeline() {
  const nowHour = new Date().getHours();
  els.sunTimeline.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    const bar = document.createElement("div");
    bar.className = "sun-bar";
    if (state.horas.includes(h)) bar.classList.add("selected");
    if (h === nowHour) bar.classList.add("now");
    bar.title = h + "h";
    els.sunTimeline.appendChild(bar);
  }
}

// ---------------- Controles (publicam no MQTT) ----------------

function publish(suffix, value) {
  if (!client || !client.connected) {
    showToast("Sem conexão com o broker — nada foi enviado");
    return false;
  }
  client.publish(topicPrefix + "/" + suffix, String(value), { retain: true, qos: 1 });
  return true;
}

function showToast(msg) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2400);
}

els.autoSwitch.addEventListener("click", () => {
  const novo = !els.autoSwitch.classList.contains("on");
  publish("automatico", novo ? "1" : "0");
});

els.manualBtn.addEventListener("click", () => {
  // CORRIGIDO: antes checava "if (state.automatico) return" -- com
  // state.automatico ainda desconhecido (null) isso deixava passar, mas
  // o botão em si ficava desabilitado pra sempre por outro motivo (ver
  // updateManualAvailability). Mantém a checagem por segurança: só
  // bloqueia quando sabemos de fato que o automático está ligado.
  if (state.automatico === true) return; // firmware ignora comando manual nesse modo
  const novo = !state.estado_bomba;
  publish("estado_bomba", novo ? "1" : "0");
});

els.meteoSwitch.addEventListener("click", () => {
  const novo = !els.meteoSwitch.classList.contains("on");
  publish("auxilio_meteorologia", novo ? "1" : "0");
});

els.advancedToggle.addEventListener("click", () => {
  els.advancedToggle.classList.toggle("open");
  els.advancedBody.classList.toggle("open");
});

els.saveConfigBtn.addEventListener("click", () => {
  // CORRIGIDO: antes mostrava "Salvo ✓" incondicionalmente, mesmo que
  // nenhum publish() tivesse de fato saído (ex.: sem conexão, ou todos
  // os campos vazios). Agora o texto reflete o que realmente aconteceu.
  const campos = [
    [els.cfgTempRef, "temperatura_referencia_tem_sol", (v) => parseInt(v, 10)],
    [els.cfgTempoRef, "tempo_referencia_tem_sol", (v) => parseInt(v, 10)],
    [els.cfgMaxDia, "tempo_maximo_ligado_dia", (v) => parseInt(v, 10)],
    [els.cfgMinDia, "tempo_minimo_ligado_dia", (v) => parseInt(v, 10)],
    [els.cfgLat, "latitude", (v) => v.trim()],
    [els.cfgLon, "longitude", (v) => v.trim()],
  ];
  let enviouAlgo = false;
  let falhouPorConexao = false;
  campos.forEach(([input, suffix, transform]) => {
    if (input.value === "") return;
    const ok = publish(suffix, transform(input.value));
    if (ok) enviouAlgo = true;
    else falhouPorConexao = true;
  });
  if (falhouPorConexao) {
    els.saveConfigBtn.textContent = "Sem conexão";
  } else if (enviouAlgo) {
    els.saveConfigBtn.textContent = "Salvo ✓";
  } else {
    els.saveConfigBtn.textContent = "Nenhum campo preenchido";
  }
  setTimeout(() => (els.saveConfigBtn.textContent = "Salvar configurações"), 1800);
});

function updateManualAvailability() {
  // CORRIGIDO: antes só habilitava quando state.automatico === false
  // (exigia ter chegado uma mensagem retida no tópico "automatico", que
  // o firmware nunca publica -- travava pra sempre). Agora só BLOQUEIA
  // quando sabemos de verdade que o automático está ligado; se ainda é
  // desconhecido, deixa o usuário tentar (com um aviso).
  const bloqueado = state.automatico === true;
  els.manualBtn.disabled = bloqueado;
  if (bloqueado) {
    els.manualSublabel.textContent = "Desative o automático para usar";
  } else if (state.automatico === false) {
    els.manualSublabel.textContent = "Vale até o automático decidir de novo";
  } else {
    els.manualSublabel.textContent = "Estado do automático ainda desconhecido — pode ser sobrescrito";
  }
}

// ---------------- Inicialização ----------------

function init() {
  // Mostra o que já sabemos do cache local, antes mesmo de conectar --
  // mas marcado como "não confirmado" nos campos que dependem disso
  // (ver TOPICOS_SO_COMANDO), até chegar uma mensagem ao vivo do broker.
  const cache = loadCache();
  Object.keys(cache).forEach((suffix) => applyValue(suffix, cache[suffix], false));
  updateManualAvailability(); // CORRIGIDO: ajusta o texto/estado inicial do botão manual

  const cfg = loadSavedConfig();
  if (!cfg) {
    openOverlay(null);
    return;
  }
  connect(cfg);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* app continua funcionando mesmo sem service worker */
    });
  });
}

init();
