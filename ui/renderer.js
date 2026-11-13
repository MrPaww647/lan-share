const connectionCard = document.getElementById('connection-card');
const desktopConnectCard = document.getElementById('desktop-connect-card');
const pairCard = document.getElementById('pair-card');
const transferCard = document.getElementById('transfer-card');
const pairForm = document.getElementById('pair-form');
const pairInput = document.getElementById('pair-input');
const transferStatus = document.getElementById('transfer-status');
const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const fileList = document.getElementById('file-list');
const emptyState = document.getElementById('empty-state');
const fileCount = document.getElementById('file-count');

let apiBase = window.location.protocol === 'file:' ? '' : window.location.origin;
const isElectron = Boolean(window.moneyflow);
let authToken = isElectron ? null : sessionStorage.getItem('moneyflow-token');
let localApiBase = null;
let localAuthToken = null;

function setStatus(message, isError) {
  transferStatus.textContent = message;
  transferStatus.classList.toggle('error', Boolean(isError));
}

function setConnectStatus(message, isError) {
  const status = document.getElementById('connect-status');
  status.textContent = message;
  status.classList.toggle('error', Boolean(isError));
}

function normalizeServerAddress(input) {
  const value = input.trim();
  const address = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
  if (
    address.protocol !== 'http:' ||
    address.username ||
    address.password ||
    address.pathname !== '/' ||
    address.search ||
    address.hash
  ) {
    throw new Error('Введите адрес HTTP-сервера из комнаты второго ПК.');
  }
  return address.origin;
}

async function api(path, options) {
  const headers = new Headers(options && options.headers ? options.headers : {});
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  const payload = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok) throw new Error(payload?.error || 'Ошибка соединения.');
  return payload;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatFileCount(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'файл' :
    mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'файла' : 'файлов';
  return `${count} ${word}`;
}

function renderFiles(files) {
  fileList.replaceChildren();
  fileCount.textContent = formatFileCount(files.length);
  emptyState.hidden = files.length > 0;

  for (const file of files) {
    const item = document.createElement('li');
    item.className = 'file-item';
    const details = document.createElement('div');
    details.className = 'file-details';
    const name = document.createElement('strong');
    name.className = 'file-name';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = formatSize(file.size);
    details.append(name, size);

    const download = document.createElement('a');
    download.className = 'button button-download';
    download.href = `${apiBase}/api/download?name=${encodeURIComponent(file.name)}`;
    download.textContent = 'Скачать';
    download.addEventListener('click', (event) => {
      event.preventDefault();
      fetch(download.href, { headers: { Authorization: `Bearer ${authToken}` } })
        .then(async (response) => {
          if (!response.ok) {
            const payload = await response.json();
            throw new Error(payload.error || 'Не удалось скачать файл.');
          }
          const blob = await response.blob();
          const temporaryUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = temporaryUrl;
          link.download = file.name;
          link.click();
          URL.revokeObjectURL(temporaryUrl);
        })
        .catch((error) => setStatus(error.message, true));
    });
    item.append(details, download);
    fileList.append(item);
  }
}

async function refreshFiles() {
  try {
    const result = await api('/api/files');
    renderFiles(result.files);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function uploadFiles(files) {
  if (!files.length) return;
  for (const file of files) {
    setStatus(`Передача: ${file.name} (${formatSize(file.size)})…`);
    try {
      const result = await api(`/api/files?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      setStatus(`Файл «${result.name}» передан.`);
    } catch (error) {
      setStatus(`${file.name}: ${error.message}`, true);
      break;
    }
  }
  fileInput.value = '';
  await refreshFiles();
}

async function initialize() {
  if (window.moneyflow) {
    const info = await window.moneyflow.getConnectionInfo();
    apiBase = `http://127.0.0.1:${info.port}`;
    document.getElementById('pair-code').textContent = info.code;
    const addressList = document.getElementById('address-list');
    if (info.addresses.length) {
      for (const address of info.addresses) {
        const addressText = document.createElement('span');
        addressText.textContent = address;
        addressList.append(addressText);
      }
    } else {
      addressList.textContent = 'Не удалось определить адрес сети. Проверьте подключение к Wi-Fi.';
    }
    connectionCard.hidden = false;
    desktopConnectCard.hidden = false;
    const paired = await api('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: info.code })
    });
    authToken = paired.token;
    localApiBase = apiBase;
    localAuthToken = authToken;
    transferCard.hidden = false;
    await refreshFiles();
    return;
  }

  pairCard.hidden = false;
  if (authToken) {
    try {
      await api('/api/files');
      pairCard.hidden = true;
      transferCard.hidden = false;
      await refreshFiles();
    } catch {
      authToken = null;
      sessionStorage.removeItem('moneyflow-token');
    }
  }
}

document.getElementById('desktop-connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('desktop-connect-button');
  const returnButton = document.getElementById('return-local-button');
  const addressInput = document.getElementById('desktop-address');
  const codeInput = document.getElementById('desktop-code');
  const connectedLabel = document.getElementById('connected-label');
  const storageLabel = document.getElementById('storage-label');
  button.disabled = true;
  setConnectStatus('Подключаемся…');

  const previousApiBase = apiBase;
  const previousAuthToken = authToken;
  try {
    const remoteApiBase = normalizeServerAddress(addressInput.value);
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) throw new Error('Код должен состоять из 6 цифр.');

    apiBase = remoteApiBase;
    authToken = null;
    const result = await api('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    authToken = result.token;
    const files = await api('/api/files');
    renderFiles(files.files);

    connectionCard.hidden = true;
    connectedLabel.textContent = `Подключено: ${new URL(remoteApiBase).host}`;
    connectedLabel.hidden = false;
    returnButton.hidden = false;
    storageLabel.textContent = 'Файлы на подключённом ПК';
    setConnectStatus('Соединение установлено.');
  } catch (error) {
    apiBase = previousApiBase;
    authToken = previousAuthToken;
    const message = error instanceof TypeError
      ? 'Не удалось подключиться. Проверьте адрес, сеть и брандмауэр.'
      : error.message;
    setConnectStatus(message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('return-local-button').addEventListener('click', () => {
  apiBase = localApiBase;
  authToken = localAuthToken;
  connectionCard.hidden = false;
  document.getElementById('connected-label').hidden = true;
  document.getElementById('return-local-button').hidden = true;
  document.getElementById('storage-label').textContent = 'Файлы в комнате этого ПК';
  setConnectStatus('Вы вернулись в комнату этого ПК.');
  refreshFiles();
});

pairForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = pairForm.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairInput.value.trim() })
    });
    authToken = result.token;
    sessionStorage.setItem('moneyflow-token', authToken);
    pairCard.hidden = true;
    transferCard.hidden = false;
    setStatus('Подключение установлено.');
    await refreshFiles();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

fileInput.addEventListener('change', () => uploadFiles(Array.from(fileInput.files)));
document.getElementById('refresh-button').addEventListener('click', refreshFiles);

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', (event) => uploadFiles(Array.from(event.dataTransfer.files)));

initialize().catch((error) => {
  setStatus(error.message || 'Не удалось запустить обмен файлами.', true);
});
