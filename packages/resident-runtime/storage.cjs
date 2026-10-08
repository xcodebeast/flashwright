/** Storage snapshots preserve UTF-16 data and bound work before building a protocol reply. */
function storageStringUnits(value) {
  return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
}
function storageStringFromUnits(units) {
  let value = '';
  for (let index = 0; index < units.length; index += 8192) value += String.fromCharCode(...units.slice(index, index + 8192));
  return value;
}
function storageFailure(error) {
  return { outcome: 'error', message: storageStringUnits(String(error.message || error).slice(0, 8192)) };
}
function collectLocalStorage() {
  try {
    const entries = [];
    let units = 0;
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      const value = localStorage.getItem(name);
      if (value === null) continue;
      units += name.length + value.length + 2;
      if (units > 100000) return { outcome: 'limit' };
      entries.push({ name: storageStringUnits(name), value: storageStringUnits(value) });
    }
    return { outcome: 'success', entries };
  } catch (error) { return storageFailure(error); }
}
function restoreLocalStorage(entries) {
  try {
    localStorage.clear();
    for (const entry of entries) localStorage.setItem(storageStringFromUnits(entry.name), storageStringFromUnits(entry.value));
    return { outcome: 'success', entries: [] };
  } catch (error) { return storageFailure(error); }
}
exports.collectLocalStorage = collectLocalStorage;
exports.restoreLocalStorage = restoreLocalStorage;
