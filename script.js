/**
 * Журнал группы — клиентское приложение без бэкенда.
 *
 * Модель данных
 * -------------
 * 1. data.json — исходные данные (предметы, ученики, оценки). Читается через fetch().
 * 2. localStorage — «слой изменений» поверх исходных данных:
 *      { schema, importedBase, added: Grade[], removed: string[], updatedAt }
 *    - added    — оценки, выставленные в браузере;
 *    - removed  — id оценок из исходного файла, которые учитель удалил;
 *    - importedBase — набор данных, загруженный учителем вручную (заменяет data.json).
 *
 * Итоговые оценки = (importedBase ?? data.json) − removed + added.
 * Слой изменений имеет приоритет над файлом. Если учитель экспортировал JSON
 * и заменил им data.json, при следующей загрузке совпадающие записи
 * автоматически убираются из слоя (pruneOverlay) — журнал снова «совпадает с data.json».
 */

'use strict';

// Обычный скрипт с defer (не ES-модуль): модули не запускаются со страниц, открытых через file://,
// а нам нужно показать подсказку и в этом случае.
const DATA_URL = './data.json';
const STORAGE_KEY = 'gradebook:v1';
const STORAGE_SCHEMA = 1;
const GRADE_SCALE = [2, 3, 4, 5];
const RECENT_LIMIT = 8;
const TOAST_MS = 6000;

/* ======================== Утилиты ======================== */

const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Создаёт DOM-элемент. Текст передаётся только как текстовые узлы — никакого innerHTML с данными.
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {...(Node|string|number|null|false|Array)} children
 * @returns {HTMLElement}
 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style') el.style.cssText = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const avgFormatter = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const longDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const pluralRules = new Intl.PluralRules('ru-RU');

/** @param {number[]} values @returns {number|null} */
const average = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

/** Средний балл с двумя знаками («4,50») или «—», если оценок нет. */
const formatAverage = (value) => (value == null ? '—' : avgFormatter.format(value));

/** Класс цвета для среднего балла: ближайшая целая оценка. */
const toneOf = (value) => (value == null ? 'tone-none' : `tone-${Math.min(5, Math.max(2, Math.round(value)))}`);

/**
 * @param {number} n
 * @param {{one: string, few: string, many: string}} forms
 */
const plural = (n, forms) => `${n} ${forms[pluralRules.select(n)] ?? forms.many}`;
const GRADE_WORDS = { one: 'оценка', few: 'оценки', many: 'оценок' };
const CHANGE_WORDS = { one: 'изменение', few: 'изменения', many: 'изменений' };

const parseISODate = (iso) => new Date(`${iso}T00:00:00`);
const formatShortDate = (iso) => shortDate.format(parseISODate(iso)).replace('.', '');
const formatLongDate = (iso) => longDate.format(parseISODate(iso));

/** Сегодняшняя дата в локальном часовом поясе, YYYY-MM-DD. */
function todayISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const isISODate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(parseISODate(value).getTime());

function makeId() {
  if (globalThis.crypto?.randomUUID) return `g-${crypto.randomUUID()}`;
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Нормализация для поиска: регистр и «ё». */
const normalizeText = (text) => text.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim();

/** Лёгкий наклон рукописной оценки — стабильный для одной и той же записи. */
function tiltFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(hash) % 9) - 4) * 1.2;
}

/** «Бауэр Лилия Сергеевна» → { surname: 'Бауэр', given: 'Лилия Сергеевна', short: 'Бауэр Л. С.' } */
function splitName(fullName) {
  const [surname = '', ...rest] = fullName.trim().split(/\s+/);
  const initials = rest.map((part) => `${part[0]}.`).join(' ');
  return { surname, given: rest.join(' '), short: initials ? `${surname} ${initials}` : surname };
}

class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

/* ======================== Данные ======================== */

/**
 * @typedef {{ id: string, name: string }} Subject
 * @typedef {{ id: string, name: string }} Student
 * @typedef {{ id: string, studentId: string, subjectId: string, value: number,
 *             date: string, comment?: string, createdAt?: string }} Grade
 * @typedef {{ group: { name: string, year?: string }, subjects: Subject[],
 *             students: Student[], grades: Grade[] }} Dataset
 * @typedef {{ added: Grade[], removed: string[] }} Overlay
 */

/**
 * @param {unknown} raw
 * @param {Pick<Grade, 'studentId'|'subjectId'>} owner
 * @param {number} index
 * @returns {Grade|null}
 */
function normalizeGrade(raw, owner, index) {
  if (!raw || typeof raw !== 'object') return null;
  const value = Number(raw.value);
  if (!GRADE_SCALE.includes(value) && value !== 1) return null;
  const grade = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${owner.studentId}-${owner.subjectId}-${index + 1}`,
    studentId: owner.studentId,
    subjectId: owner.subjectId,
    value,
    date: isISODate(raw.date) ? raw.date : todayISO(),
  };
  if (typeof raw.comment === 'string' && raw.comment.trim()) grade.comment = raw.comment.trim();
  return grade;
}

/**
 * Проверяет JSON журнала и приводит к внутреннему виду (плоский список оценок).
 * @param {unknown} raw
 * @returns {Dataset}
 */
function normalizeDataset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DataError('Файл не похож на журнал: ожидается JSON-объект с полями subjects и students.');
  }
  if (!Array.isArray(raw.subjects) || !Array.isArray(raw.students)) {
    throw new DataError('В файле нет списков subjects и students.');
  }

  const subjects = raw.subjects
    .filter((s) => typeof s?.id === 'string' && typeof s?.name === 'string')
    .map(({ id, name }) => ({ id, name }));
  const subjectIds = new Set(subjects.map((s) => s.id));

  const students = [];
  const grades = [];
  const seenGradeIds = new Set();

  raw.students.forEach((s, i) => {
    if (typeof s?.name !== 'string' || !s.name.trim()) return;
    const id = typeof s.id === 'string' && s.id ? s.id : `st${String(i + 1).padStart(2, '0')}`;
    students.push({ id, name: s.name.trim() });

    for (const [subjectId, list] of Object.entries(s.grades ?? {})) {
      if (!subjectIds.has(subjectId) || !Array.isArray(list)) continue;
      list.forEach((g, index) => {
        const grade = normalizeGrade(g, { studentId: id, subjectId }, index);
        if (grade && !seenGradeIds.has(grade.id)) {
          seenGradeIds.add(grade.id);
          grades.push(grade);
        }
      });
    }
  });

  if (!subjects.length) throw new DataError('В файле не указан ни один предмет.');
  if (!students.length) throw new DataError('В файле нет ни одного ученика.');

  const group = {
    name: typeof raw.group?.name === 'string' ? raw.group.name : 'Группа',
    ...(typeof raw.group?.year === 'string' ? { year: raw.group.year } : {}),
  };
  return { group, subjects, students, grades };
}

/**
 * Загружает data.json. Отключаем HTTP-кэш, чтобы обновлённый файл на GitHub Pages подхватывался сразу.
 * @returns {Promise<Dataset>}
 */
async function fetchDataset() {
  let response;
  try {
    response = await fetch(DATA_URL, { cache: 'no-cache' });
  } catch (err) {
    throw new DataError(
      location.protocol === 'file:'
        ? 'Браузер не разрешает читать data.json, когда страница открыта как файл (file://).'
        : `Не удалось загрузить data.json: ${err.message}.`,
    );
  }
  if (!response.ok) {
    throw new DataError(`Сервер ответил ошибкой ${response.status} при загрузке data.json. Проверьте, что файл лежит рядом с index.html.`);
  }
  try {
    return normalizeDataset(await response.json());
  } catch (err) {
    if (err instanceof DataError) throw err;
    throw new DataError('data.json содержит ошибку в формате JSON. Проверьте запятые и кавычки.');
  }
}

/* ---------- localStorage ---------- */

const emptyStored = () => ({ schema: STORAGE_SCHEMA, importedBase: null, added: [], removed: [] });

/** Читает слой изменений; при повреждённых данных возвращает пустой слой. */
function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStored();
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== STORAGE_SCHEMA) return emptyStored();
    return {
      schema: STORAGE_SCHEMA,
      importedBase: parsed.importedBase ? normalizeDataset(parsed.importedBase) : null,
      added: Array.isArray(parsed.added) ? parsed.added.filter(isStoredGrade) : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed.filter((id) => typeof id === 'string') : [],
    };
  } catch (err) {
    console.warn('Слой изменений в localStorage повреждён и будет проигнорирован:', err);
    return emptyStored();
  }
}

function isStoredGrade(g) {
  return typeof g?.id === 'string' && typeof g.studentId === 'string' && typeof g.subjectId === 'string'
    && GRADE_SCALE.includes(g.value) && isISODate(g.date);
}

/**
 * @param {{ importedBase: Dataset|null } & Overlay} stored
 * @returns {boolean} удалось ли сохранить
 */
function writeStorage(stored) {
  try {
    const isEmpty = !stored.importedBase && !stored.added.length && !stored.removed.length;
    if (isEmpty) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, schema: STORAGE_SCHEMA, updatedAt: new Date().toISOString() }));
    return true;
  } catch (err) {
    console.error('Не удалось сохранить в localStorage:', err);
    return false;
  }
}

/* ---------- Слияние ---------- */

/**
 * Убирает из слоя то, что уже отражено в исходных данных:
 * добавленные оценки, которые есть в файле, и удаления оценок, которых в файле уже нет.
 * @param {Grade[]} baseGrades
 * @param {Overlay} overlay
 * @returns {Overlay}
 */
function pruneOverlay(baseGrades, overlay) {
  const baseIds = new Set(baseGrades.map((g) => g.id));
  return {
    added: overlay.added.filter((g) => !baseIds.has(g.id)),
    removed: [...new Set(overlay.removed)].filter((id) => baseIds.has(id)),
  };
}

/**
 * Итоговый список оценок: исходные − удалённые + добавленные (только для существующих учеников и предметов).
 * @param {Dataset} base
 * @param {Overlay} overlay
 * @returns {Grade[]}
 */
function mergeGrades(base, overlay) {
  const removed = new Set(overlay.removed);
  const studentIds = new Set(base.students.map((s) => s.id));
  const subjectIds = new Set(base.subjects.map((s) => s.id));
  const extra = overlay.added.filter((g) => studentIds.has(g.studentId) && subjectIds.has(g.subjectId));
  return [...base.grades.filter((g) => !removed.has(g.id)), ...extra];
}

/**
 * Индекс «ученик → предмет → оценки по дате».
 * @param {Grade[]} grades
 * @returns {Map<string, Map<string, Grade[]>>}
 */
function indexGrades(grades) {
  const index = new Map();
  for (const g of grades) {
    if (!index.has(g.studentId)) index.set(g.studentId, new Map());
    const bySubject = index.get(g.studentId);
    if (!bySubject.has(g.subjectId)) bySubject.set(g.subjectId, []);
    bySubject.get(g.subjectId).push(g);
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  for (const bySubject of index.values()) for (const list of bySubject.values()) list.sort(byDate);
  return index;
}

/** Собирает JSON в формате data.json из текущего состояния. */
function buildExport() {
  const { base } = state;
  return {
    group: base.group,
    subjects: base.subjects,
    students: base.students.map((student) => ({
      id: student.id,
      name: student.name,
      grades: Object.fromEntries(base.subjects.map((subject) => [
        subject.id,
        gradesOf(student.id, subject.id).map(({ id, value, date, comment }) => (comment ? { id, value, date, comment } : { id, value, date })),
      ])),
    })),
    exportedAt: new Date().toISOString(),
  };
}

/* ======================== Состояние ======================== */

const state = {
  /** @type {Dataset|null} данные из data.json */
  fileBase: null,
  /** @type {Dataset|null} данные из загруженного вручную файла */
  importedBase: null,
  /** @type {Dataset|null} активная основа (importedBase ?? fileBase) */
  base: null,
  /** @type {Overlay} */
  overlay: { added: [], removed: [] },
  /** @type {Map<string, Map<string, Grade[]>>} */
  index: new Map(),
  /** @type {Set<string>} id оценок, которые нужно «вписать» с анимацией */
  fresh: new Set(),
  openStudentId: null,
};

const gradesOf = (studentId, subjectId) => state.index.get(studentId)?.get(subjectId) ?? [];
const allGradesOf = (studentId) => [...(state.index.get(studentId)?.values() ?? [])].flat();
const studentById = (id) => state.base?.students.find((s) => s.id === id) ?? null;
const subjectById = (id) => state.base?.subjects.find((s) => s.id === id) ?? null;
const pendingCount = () => state.overlay.added.length + state.overlay.removed.length;

/** Пересчитывает итоговые данные из основы и слоя изменений. */
function recompute() {
  state.base = state.importedBase ?? state.fileBase;
  if (!state.base) return;
  state.overlay = pruneOverlay(state.base.grades, state.overlay);
  state.index = indexGrades(mergeGrades(state.base, state.overlay));
}

/**
 * Применяет изменение слоя, сохраняет его и перерисовывает интерфейс.
 * @param {(overlay: Overlay) => Overlay} update
 * @returns {boolean}
 */
function commit(update) {
  const previous = state.overlay;
  state.overlay = update(previous);
  const ok = writeStorage({ importedBase: state.importedBase, ...state.overlay });
  if (!ok) {
    state.overlay = previous;
    toast('Не удалось сохранить: хранилище браузера переполнено или отключено. Экспортируйте JSON, чтобы не потерять оценки.', { tone: 'error' });
    return false;
  }
  recompute();
  renderAll();
  return true;
}

/** Синхронизирует состояние с localStorage (при загрузке и при изменениях в другой вкладке). */
function loadFromStorage() {
  const stored = readStorage();
  state.importedBase = stored.importedBase;
  state.overlay = { added: stored.added, removed: stored.removed };
  recompute();
}

/* ---------- Действия ---------- */

/**
 * @param {Omit<Grade, 'id'|'createdAt'>} input
 * @returns {Grade|null}
 */
function addGrade(input) {
  const grade = { ...input, id: makeId(), createdAt: new Date().toISOString() };
  if (!grade.comment) delete grade.comment;
  state.fresh.add(grade.id);
  return commit((o) => ({ ...o, added: [...o.added, grade] })) ? grade : null;
}

/** Удаляет оценку: свою — из слоя, исходную — помечает как удалённую. */
function deleteGrade(gradeId) {
  const isLocal = state.overlay.added.some((g) => g.id === gradeId);
  return commit((o) => (isLocal
    ? { ...o, added: o.added.filter((g) => g.id !== gradeId) }
    : { ...o, removed: [...o.removed, gradeId] }));
}

/** Возвращает удалённую оценку обратно (для кнопки «Отменить»). */
function restoreGrade(grade) {
  const fromBase = state.base.grades.some((g) => g.id === grade.id);
  state.fresh.add(grade.id);
  return commit((o) => (fromBase
    ? { ...o, removed: o.removed.filter((id) => id !== grade.id) }
    : { ...o, added: [...o.added, grade] }));
}

/* ======================== Отрисовка ======================== */

const avatarTemplate = /** @type {HTMLTemplateElement} */ ($('#avatar-template'));
const avatar = (extraClass = '') => h('span', { class: `avatar ${extraClass}`.trim() }, avatarTemplate.content.cloneNode(true));

/**
 * Рукописная оценка.
 * @param {Grade} grade
 * @param {{ withTitle?: boolean }} [options]
 */
function markEl(grade, { withTitle = true } = {}) {
  const subject = subjectById(grade.subjectId)?.name ?? '';
  const title = withTitle
    ? [`${grade.value} — ${formatLongDate(grade.date)}`, subject, grade.comment].filter(Boolean).join('\n')
    : null;
  const isFresh = state.fresh.has(grade.id);
  return h('span', {
    class: `mark mark--${grade.value}${isFresh ? ' mark--fresh' : ''}`,
    style: `--tilt: ${tiltFor(grade.id)}deg`,
    title,
    role: withTitle ? 'img' : null,
    'aria-label': withTitle ? `${grade.value}, ${formatLongDate(grade.date)}${grade.comment ? `, ${grade.comment}` : ''}` : null,
  }, String(grade.value));
}

function renderAll() {
  renderHeader();
  renderSyncBar();
  renderRegister();
  renderGradeForm();
  if (state.openStudentId) renderStudentDialog(state.openStudentId);
  state.fresh.clear();
}

function renderHeader() {
  const { group } = state.base;
  $('#group-title').textContent = `Журнал: ${group.name}`;
  $('#group-year').textContent = group.year ? `Учебный год ${group.year}` : '';
  document.title = `Журнал — ${group.name}`;
}

function renderSyncBar() {
  const bar = $('#syncbar');
  const n = pendingCount();
  const source = state.importedBase ? 'загруженного файла' : 'data.json';
  bar.hidden = false;
  bar.dataset.state = n ? 'pending' : 'clean';

  const text = n
    ? `Только в этом браузере: ${plural(n, CHANGE_WORDS)}. Экспортируйте JSON, чтобы перенести их в data.json.`
    : (state.importedBase ? 'Журнал открыт из загруженного файла, новых изменений нет.' : 'Все оценки совпадают с data.json.');
  $('#sync-text').textContent = text;
  $('#btn-reset').disabled = !n && !state.importedBase;
  $('#btn-reset').title = state.importedBase ? `Сейчас используется копия из ${source}` : '';
}

/* ---------- Раздел «Ученики» ---------- */

const ui = { query: '', sort: 'list' };

function renderRegister() {
  const { students } = state.base;
  const query = normalizeText(ui.query);
  const rows = students
    .map((student, i) => {
      const grades = allGradesOf(student.id);
      return { student, number: i + 1, grades, avg: average(grades.map((g) => g.value)) };
    })
    .filter(({ student }) => !query || normalizeText(student.name).includes(query));

  if (ui.sort !== 'list') {
    const dir = ui.sort === 'avg-desc' ? -1 : 1;
    rows.sort((a, b) => ((a.avg ?? (dir < 0 ? -1 : 99)) - (b.avg ?? (dir < 0 ? -1 : 99))) * dir || a.number - b.number);
  }

  const list = $('#register');
  list.replaceChildren(...rows.map(({ student, number, grades, avg }) => {
    const { surname, given } = splitName(student.name);
    const latest = [...grades].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 5).reverse();
    return h('li', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'row__btn',
        dataset: { student: student.id },
        'aria-label': `${student.name}, средний балл ${formatAverage(avg)}. Открыть оценки`,
      },
      h('span', { class: 'row__num' }, number),
      avatar(),
      h('span', { class: 'row__name' }, h('span', { class: 'row__surname' }, surname), given ? ' ' : null, h('span', { class: 'row__given' }, given)),
      h('span', { class: 'row__marks', 'aria-hidden': 'true' }, latest.map((g) => markEl(g, { withTitle: false }))),
      h('span', { class: `row__avg ${toneOf(avg)}` }, formatAverage(avg))));
  }));
  $('#register-empty').hidden = rows.length > 0;

  const total = state.base.students.reduce((sum, s) => sum + allGradesOf(s.id).length, 0);
  const groupAvg = average(state.base.students.flatMap((s) => allGradesOf(s.id).map((g) => g.value)));
  $('#group-summary').textContent = `${plural(students.length, { one: 'ученик', few: 'ученика', many: 'учеников' })}, ${plural(total, GRADE_WORDS)}, средний балл группы ${formatAverage(groupAvg)}. Нажмите на ученика, чтобы увидеть оценки по предметам.`;
}

/* ---------- Карточка ученика ---------- */

const studentDialog = /** @type {HTMLDialogElement} */ ($('#student-dialog'));

function renderStudentDialog(studentId) {
  const student = studentById(studentId);
  if (!student) {
    studentDialog.close();
    return;
  }
  const all = allGradesOf(student.id);
  const overall = average(all.map((g) => g.value));

  $('[data-avatar]', studentDialog).replaceChildren(avatarTemplate.content.cloneNode(true));
  $('#sd-name').textContent = student.name;
  $('#sd-meta').textContent = `${state.base.group.name}, ${plural(all.length, GRADE_WORDS)}`;
  const avgEl = $('#sd-avg');
  avgEl.textContent = formatAverage(overall);
  avgEl.className = `modal__overall-value ${toneOf(overall)}`;

  $('#sd-rows').replaceChildren(...state.base.subjects.map((subject) => {
    const grades = gradesOf(student.id, subject.id);
    const avg = average(grades.map((g) => g.value));
    return h('tr', {},
      h('th', { scope: 'row', class: 'subjects-table__subject' },
        subject.name,
        h('span', { class: 'subjects-table__count' }, grades.length ? plural(grades.length, GRADE_WORDS) : '')),
      h('td', {}, grades.length
        ? h('span', { class: 'marks-line' }, grades.map((g) => markEl(g)))
        : h('span', { class: 'no-marks' }, 'Нет оценок')),
      h('td', { class: `num ${toneOf(avg)}` }, formatAverage(avg)));
  }));
}

function openStudent(studentId) {
  state.openStudentId = studentId;
  renderStudentDialog(studentId);
  if (!studentDialog.open) studentDialog.showModal();
}

/* ---------- Раздел «Выставить оценку» ---------- */

const form = /** @type {HTMLFormElement} */ ($('#grade-form'));
const fStudent = /** @type {HTMLSelectElement} */ ($('#f-student'));
const fSubject = /** @type {HTMLSelectElement} */ ($('#f-subject'));
const fDate = /** @type {HTMLInputElement} */ ($('#f-date'));
const fComment = /** @type {HTMLInputElement} */ ($('#f-comment'));

/** Заполняет выпадающие списки, сохраняя текущий выбор. */
function fillSelect(select, items, label) {
  const current = select.value;
  select.replaceChildren(
    h('option', { value: '' }, label),
    ...items.map((item) => h('option', { value: item.id }, item.label)),
  );
  select.value = items.some((i) => i.id === current) ? current : '';
}

function renderGradeForm() {
  fillSelect(fStudent, state.base.students.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.name}` })), 'Выберите ученика');
  fillSelect(fSubject, state.base.subjects.map((s) => ({ id: s.id, label: s.name })), 'Выберите предмет');
  renderPreview();
  renderRecent();
}

function renderMarkPicker() {
  $('#f-marks').replaceChildren(...GRADE_SCALE.map((value) => h('label', { class: `mark-option tone-${value}` },
    h('input', { type: 'radio', name: 'mark', value, 'aria-label': `Оценка ${value}` }),
    h('span', { class: 'mark-option__face', 'aria-hidden': 'true' }, value))));
}

/** Строка оценки с кнопкой удаления. */
function entryEl(grade, { subline, showNew }) {
  const isLocal = state.overlay.added.some((g) => g.id === grade.id);
  return h('li', { class: 'entry' },
    markEl(grade),
    h('span', { class: 'entry__text' },
      subline.main,
      showNew && isLocal ? h('span', { class: 'entry__new' }, 'не в data.json') : null,
      subline.sub ? h('span', { class: 'entry__sub' }, subline.sub) : null),
    h('button', {
      type: 'button',
      class: 'entry__delete',
      dataset: { deleteGrade: grade.id },
      'aria-label': `Удалить оценку ${grade.value} от ${formatLongDate(grade.date)}`,
    }, 'Удалить'));
}

function renderPreview() {
  const box = $('#preview');
  const student = studentById(fStudent.value);
  const subject = subjectById(fSubject.value);

  if (!student || !subject) {
    box.replaceChildren(h('p', { class: 'empty empty--small' },
      'Выберите ученика и предмет — здесь появятся его оценки и средний балл.'));
    return;
  }

  const grades = gradesOf(student.id, subject.id);
  const avg = average(grades.map((g) => g.value));
  const summary = h('div', { class: 'preview__summary' },
    h('span', { class: 'preview__who' }, splitName(student.name).short, h('span', { class: 'preview__subject' }, subject.name)),
    h('span', { class: 'preview__avg' },
      h('span', { class: `preview__avg-value ${toneOf(avg)}` }, formatAverage(avg)),
      h('span', { class: 'preview__avg-label' }, 'средний балл')));

  const list = grades.length
    ? h('ol', { class: 'entries', reversed: true }, [...grades].reverse().map((g) => entryEl(g, {
      subline: { main: formatLongDate(g.date), sub: g.comment },
      showNew: true,
    })))
    : h('p', { class: 'empty empty--small' }, 'Оценок по этому предмету пока нет. Первая появится здесь.');

  box.replaceChildren(summary, list);
}

function renderRecent() {
  const recent = [...state.overlay.added]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, RECENT_LIMIT);
  $('#recent').replaceChildren(...recent.map((g) => entryEl(g, {
    subline: {
      main: splitName(studentById(g.studentId)?.name ?? '').short,
      sub: `${subjectById(g.subjectId)?.name ?? ''}, ${formatShortDate(g.date)}${g.comment ? `. ${g.comment}` : ''}`,
    },
    showNew: false,
  })));
  $('#recent-empty').hidden = recent.length > 0;
}

function showFormError(message, field) {
  const box = $('#form-error');
  box.textContent = message;
  box.hidden = false;
  for (const el of [fStudent, fSubject, fDate]) el.removeAttribute('aria-invalid');
  if (field instanceof HTMLElement && field.matches('select, input:not([type="radio"])')) field.setAttribute('aria-invalid', 'true');
  field?.focus();
}

function clearFormError() {
  $('#form-error').hidden = true;
  for (const el of [fStudent, fSubject, fDate]) el.removeAttribute('aria-invalid');
}

function handleSubmit(event) {
  event.preventDefault();
  const mark = form.elements.namedItem('mark');
  const value = Number(/** @type {RadioNodeList} */ (mark).value);

  if (!fStudent.value) return showFormError('Выберите ученика.', fStudent);
  if (!fSubject.value) return showFormError('Выберите предмет.', fSubject);
  if (!GRADE_SCALE.includes(value)) return showFormError('Выберите оценку от 2 до 5.', $('#f-marks input'));
  if (!isISODate(fDate.value)) return showFormError('Укажите дату оценки.', fDate);
  if (fDate.value > todayISO()) return showFormError('Дата не может быть в будущем.', fDate);
  clearFormError();

  const grade = addGrade({
    studentId: fStudent.value,
    subjectId: fSubject.value,
    value,
    date: fDate.value,
    comment: fComment.value.trim(),
  });
  if (!grade) return;

  // Ученик и предмет остаются выбранными — удобно ставить несколько оценок подряд.
  for (const radio of form.querySelectorAll('input[name="mark"]')) radio.checked = false;
  fComment.value = '';

  const who = splitName(studentById(grade.studentId).name).short;
  toast(`Оценка ${grade.value} сохранена: ${who}, ${subjectById(grade.subjectId).name}.`, {
    action: { label: 'Отменить', run: () => deleteGrade(grade.id) && toast('Оценка удалена.') },
  });
}

function handleDelete(gradeId) {
  const grade = [...state.index.values()].flatMap((m) => [...m.values()].flat()).find((g) => g.id === gradeId);
  if (!grade || !deleteGrade(gradeId)) return;
  toast(`Оценка ${grade.value} от ${formatShortDate(grade.date)} удалена.`, {
    action: { label: 'Отменить', run: () => restoreGrade(grade) && toast('Оценка восстановлена.') },
  });
}

/* ---------- Уведомления ---------- */

/**
 * @param {string} message
 * @param {{ tone?: 'error', action?: { label: string, run: () => void } }} [options]
 */
function toast(message, { tone, action } = {}) {
  const box = $('#toasts');
  const el = h('div', { class: `toast${tone ? ` toast--${tone}` : ''}`, role: tone === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast__text' }, message));
  const dismiss = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    el.append(h('button', {
      type: 'button',
      class: 'toast__action',
      onclick: () => {
        dismiss();
        action.run();
      },
    }, action.label));
  }
  while (box.children.length >= 3) box.firstElementChild.remove();
  box.append(el);
  setTimeout(dismiss, tone === 'error' ? TOAST_MS * 2 : TOAST_MS);
}

/* ---------- Экспорт, импорт, сброс ---------- */

function exportJSON() {
  const blob = new Blob([`${JSON.stringify(buildExport(), null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'data.json' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Файл data.json скачан. Замените им data.json в репозитории — изменения станут общими.');
}

/** @param {File} file */
async function importJSON(file) {
  try {
    const dataset = normalizeDataset(JSON.parse(await file.text()));
    const ok = writeStorage({ importedBase: dataset, added: [], removed: [] });
    if (!ok) throw new DataError('Не удалось сохранить файл в хранилище браузера.');
    state.importedBase = dataset;
    state.overlay = { added: [], removed: [] };
    recompute();
    showApp();
    renderAll();
    toast(`Журнал загружен из файла «${file.name}»: ${plural(dataset.students.length, { one: 'ученик', few: 'ученика', many: 'учеников' })}.`);
  } catch (err) {
    const message = err instanceof DataError ? err.message : 'Файл не читается как JSON.';
    toast(`Файл не загружен. ${message}`, { tone: 'error' });
  }
}

const confirmDialog = /** @type {HTMLDialogElement} */ ($('#confirm-dialog'));

function askReset() {
  const n = pendingCount();
  const parts = [];
  if (n) parts.push(`${plural(n, CHANGE_WORDS)} из этого браузера будут удалены.`);
  if (state.importedBase) parts.push('Загруженный вручную файл перестанет использоваться.');
  parts.push('Если изменения нужны, сначала экспортируйте JSON.');
  $('#cd-text').textContent = parts.join(' ');
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
}

async function resetToFile() {
  writeStorage({ importedBase: null, added: [], removed: [] });
  state.importedBase = null;
  state.overlay = { added: [], removed: [] };
  if (!state.fileBase) {
    await boot();
    return;
  }
  recompute();
  renderAll();
  toast('Журнал сброшен к data.json.');
}

/* ======================== Навигация ======================== */

const ROUTES = ['students', 'grade'];
/** @type {HTMLElement|null} элемент, который получит фокус после смены раздела */
let pendingFocus = null;

function currentRoute() {
  const route = location.hash.slice(1);
  return ROUTES.includes(route) ? route : 'students';
}

function applyRoute() {
  if (!state.base) return;
  const route = currentRoute();
  $('#view-students').hidden = route !== 'students';
  $('#view-grade').hidden = route !== 'grade';
  for (const link of document.querySelectorAll('.tabs__link')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function showApp() {
  $('#loading').hidden = true;
  $('#view-error').hidden = true;
  applyRoute();
}

/**
 * @param {Error} err
 */
function showError(err) {
  $('#loading').hidden = true;
  $('#view-students').hidden = true;
  $('#view-grade').hidden = true;
  $('#syncbar').hidden = true;
  $('#view-error').hidden = false;
  $('#error-message').textContent = err instanceof DataError ? err.message : `Неожиданная ошибка: ${err.message}`;

  const hint = $('#error-hint');
  if (location.protocol === 'file:') {
    hint.replaceChildren(
      h('p', {}, 'Откройте журнал через веб-сервер:'),
      h('ol', {},
        h('li', {}, 'на GitHub Pages — просто откройте ссылку на сайт;'),
        h('li', {}, 'на компьютере — в папке проекта выполните ', h('code', {}, 'python -m http.server 8000'),
          ' и откройте ', h('code', {}, 'http://localhost:8000'), ';'),
        h('li', {}, 'или нажмите «Выбрать data.json вручную» ниже.')),
    );
  } else {
    hint.replaceChildren(h('p', {}, 'Убедитесь, что data.json загружен в репозиторий рядом с index.html, или выберите файл вручную.'));
  }
}

/* ======================== События ======================== */

function bindEvents() {
  window.addEventListener('hashchange', () => {
    applyRoute();
    (pendingFocus ?? $('#main')).focus({ preventScroll: !pendingFocus });
    pendingFocus = null;
  });

  $('#search').addEventListener('input', (e) => {
    ui.query = e.target.value;
    renderRegister();
  });
  $('#sort').addEventListener('change', (e) => {
    ui.sort = e.target.value;
    renderRegister();
  });

  $('#register').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-student]');
    if (btn) openStudent(btn.dataset.student);
  });

  // Закрытие карточки: крестик, кнопка «Закрыть», клик по фону; Esc обрабатывает сам <dialog>.
  studentDialog.addEventListener('click', (e) => {
    if (e.target === studentDialog || e.target.closest('[data-close]')) studentDialog.close();
  });
  studentDialog.addEventListener('close', () => {
    const id = state.openStudentId;
    state.openStudentId = null;
    // Возвращаем фокус на строку ученика.
    if (id && currentRoute() === 'students') document.querySelector(`.row__btn[data-student="${CSS.escape(id)}"]`)?.focus();
  });
  $('#sd-grade').addEventListener('click', () => {
    const id = state.openStudentId;
    studentDialog.close();
    fStudent.value = id;
    renderPreview();
    if (currentRoute() === 'grade') fSubject.focus();
    else {
      pendingFocus = fSubject;
      location.hash = '#grade';
    }
  });

  form.addEventListener('submit', handleSubmit);
  for (const el of [fStudent, fSubject]) {
    el.addEventListener('change', () => {
      clearFormError();
      renderPreview();
    });
  }
  form.addEventListener('change', (e) => {
    if (e.target.name === 'mark') clearFormError();
  });

  $('#view-grade').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete-grade]');
    if (btn) handleDelete(btn.dataset.deleteGrade);
  });

  $('#btn-export').addEventListener('click', exportJSON);
  $('#btn-reset').addEventListener('click', askReset);
  confirmDialog.addEventListener('close', () => {
    if (confirmDialog.returnValue === 'confirm') resetToFile();
  });
  confirmDialog.addEventListener('click', (e) => {
    if (e.target === confirmDialog) confirmDialog.close('cancel');
  });

  $('#import-file').addEventListener('change', async (e) => {
    const [file] = e.target.files ?? [];
    e.target.value = '';
    if (file) await importJSON(file);
  });

  $('#btn-retry').addEventListener('click', boot);

  // Изменения из другой вкладки с этим же журналом.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    loadFromStorage();
    if (!state.base) {
      boot();
      return;
    }
    showApp();
    renderAll();
  });
}

/* ======================== Запуск ======================== */

async function boot() {
  $('#loading').hidden = false;
  $('#view-error').hidden = true;

  const stored = readStorage();
  state.importedBase = stored.importedBase;
  state.overlay = { added: stored.added, removed: stored.removed };

  try {
    state.fileBase = await fetchDataset();
  } catch (err) {
    state.fileBase = null;
    // Если учитель ранее загрузил файл вручную, журнал работает и без data.json.
    if (!state.importedBase) {
      console.error(err);
      showError(err);
      return;
    }
  }

  const before = pendingCount();
  recompute();
  // Слой мог «схлопнуться», если data.json уже содержит экспортированные изменения.
  if (pendingCount() !== before) writeStorage({ importedBase: state.importedBase, ...state.overlay });

  showApp();
  renderAll();
}

renderMarkPicker();
fDate.value = todayISO();
fDate.max = todayISO();
bindEvents();
boot();
