'use strict';

/*
 * Saisie d'un projet artistique dans la table Projets_par_ecole.
 *
 * Une ligne par envoi : un même établissement peut porter plusieurs projets
 * la même année, avec des intitulés et des niveaux distincts. C'est le
 * fonctionnement que la carte attend, elle regroupe déjà les lignes d'une
 * même école.
 *
 * Les niveaux ne s'écrivent PAS dans Niveau_x_, qui est une colonne formule.
 * On écrit 1 dans les drapeaux TPS2, PS2, MS2… et dans ASH ; la formule en
 * déduit la liste de choix, et les colonnes TPS, PS, MS… y puisent l'effectif
 * de l'école. C'est cet effectif que la carte lit pour filtrer les niveaux.
 *
 * La table Ecoles a une ligne par école et par année scolaire : le projet
 * référence la ligne de SON année, pour que ses effectifs restent ceux de
 * l'année du projet (voir shared/school-years.js).
 */

(function () {

    const TABLE_PROJECTS = 'Projets_par_ecole';
    const TABLE_SCHOOLS = 'Ecoles';

    const COL_SCHOOL = 'UAI';
    const COL_YEAR = 'Annee';

    const MAX_TITLE_LENGTH = 200;
    const MAX_RESULTS = 40;

    // Colonnes de domaines, dans l'ordre d'affichage du formulaire.
    const DOMAINS = [
        { col: 'Arts_visuels', label: 'Arts visuels' },
        { col: 'Patrimoine', label: 'Patrimoine' },
        { col: 'Cinema_et_audiovisuel', label: 'Cinéma et audiovisuel' },
        { col: 'CSTI', label: 'CSTI' },
        { col: 'Histoire_et_memoire', label: 'Histoire et mémoire' },
        { col: 'EMI', label: 'EMI' },
        { col: 'Livre_et_lecture', label: 'Livre et lecture' },
        { col: 'Musique', label: 'Musique' },
        { col: 'Spectacle_vivant', label: 'Spectacle vivant' }
    ];

    // Niveaux : `flag` est la colonne à mettre à 1 dans Projets_par_ecole,
    // `count` la colonne d'effectif à lire dans Ecoles pour information.
    // ASH n'a pas d'effectif propre et porte son propre nom de drapeau.
    const LEVELS = [
        { name: 'TPS', flag: 'TPS2', count: 'TPS' },
        { name: 'PS', flag: 'PS2', count: 'PS' },
        { name: 'MS', flag: 'MS2', count: 'MS' },
        { name: 'GS', flag: 'GS2', count: 'GS' },
        { name: 'CP', flag: 'CP2', count: 'CP' },
        { name: 'CE1', flag: 'CE1_2', count: 'CE1' },
        { name: 'CE2', flag: 'CE2_2', count: 'CE2' },
        { name: 'CM1', flag: 'CM1_2', count: 'CM1' },
        { name: 'CM2', flag: 'CM2_2', count: 'CM2' },
        { name: 'ASH', flag: 'ASH', count: null }
    ];

    const SCHOOL_FIELDS = ['UAI', 'Nom', 'Complement', 'Commune', 'Circo', 'Code_postal', 'Annee'];
    const MAX_COUNT = 999;

    let schoolIndex = null;
    let schools = [];
    let writableCountColumns = new Set();
    let savingCounts = false;
    let projects = [];
    let levels = LEVELS;
    let domains = DOMAINS;
    let selectedSchool = null;
    let activeOption = -1;
    let results = [];
    let pendingDuplicate = false;
    let submitting = false;

    const el = {};

    /* ------------------------------------------------------------------
     * Utilitaires
     * ---------------------------------------------------------------- */

    function normalize(value) {
        return window.SearchText ? window.SearchText.normalize(value) : String(value ?? '').toLowerCase().trim();
    }

    function text(value) {
        return typeof value === 'string' ? value.trim() : (value === null || value === undefined ? '' : String(value));
    }

    function toCount(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function currentSchoolYear() {
        return window.SchoolYears.currentSchoolYear();
    }

    function bootError(message) {
        el.bootErrorText.textContent = message;
        el.bootError.hidden = false;
    }

    function setStatus(message, kind) {
        el.status.textContent = message;
        el.status.className = 'status' + (kind ? ' status-' + kind : '');
    }

    function setFieldError(errorEl, inputEl, message) {
        if (message) {
            errorEl.textContent = message;
            errorEl.hidden = false;
            if (inputEl) inputEl.classList.add('is-invalid');
        } else {
            errorEl.textContent = '';
            errorEl.hidden = true;
            if (inputEl) inputEl.classList.remove('is-invalid');
        }
    }

    function clearErrors() {
        setFieldError(el.schoolError, el.schoolInput, '');
        setFieldError(el.titleError, el.titleInput, '');
        setFieldError(el.levelsError, null, '');
        setFieldError(el.domainsError, null, '');
    }

    // Toute modification du formulaire annule une confirmation en attente :
    // le doublon signalé ne correspond plus forcément à ce qui est saisi.
    function resetDuplicateGuard() {
        if (!pendingDuplicate) return;
        pendingDuplicate = false;
        el.submitBtn.textContent = 'Enregistrer le projet';
        el.submitBtn.classList.remove('btn-warn');
        setStatus('', null);
    }

    function checkedValues(container) {
        return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
    }

    function uncheckAll(container) {
        for (const cb of container.querySelectorAll('input[type="checkbox"]')) {
            cb.checked = false;
        }
    }

    /* ------------------------------------------------------------------
     * Lecture du document
     * ---------------------------------------------------------------- */

    function columnValues(table, colId) {
        const values = table ? table[colId] : null;
        return Array.isArray(values) ? values : [];
    }

    // Lit toutes les lignes de Ecoles, toutes années confondues. La liste
    // proposée à la recherche en est extraite par refreshSchoolList().
    async function loadSchools() {
        const data = await grist.docApi.fetchTable(TABLE_SCHOOLS);
        const ids = columnValues(data, 'id');
        const records = [];

        for (let i = 0; i < ids.length; i += 1) {
            // `counts` : nombre ou null (effectif non renseigné), pour que la
            // fenêtre des effectifs distingue une case vide d'un zéro.
            const school = { id: Number(ids[i]), counts: {} };

            for (const field of SCHOOL_FIELDS) {
                school[field] = text(columnValues(data, field)[i]);
            }
            for (const level of LEVELS) {
                if (level.count) {
                    const raw = columnValues(data, level.count)[i];
                    school.counts[level.name] = raw === null || raw === undefined || raw === '' ? null : toCount(raw);
                }
            }

            school.uai = school.UAI;
            school.year = school.Annee;
            school.label = [school.Nom, school.Complement].filter(Boolean).join(' ');
            school.meta = [school.Commune, school.UAI].filter(Boolean).join(' · ');
            school.haystack = normalize(
                [school.Nom, school.Complement, school.Commune, school.UAI, school.Code_postal, school.Circo]
                    .filter(Boolean).join(' ')
            );
            school.sortKey = normalize(school.Commune + ' ' + school.Nom);

            if (school.label || school.UAI) {
                records.push(school);
            }
        }

        schoolIndex = window.SchoolYears.buildIndex(records);
    }

    // Écoles existant l'année choisie, et école retenue ramenée à la ligne de
    // cette année. Retourne false si l'école retenue n'existe pas cette année.
    function refreshSchoolList() {
        const year = el.yearSelect.value;
        const list = schoolIndex ? schoolIndex.schoolsFor(year) : [];
        list.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'fr'));
        schools = list;

        if (!selectedSchool) {
            return true;
        }
        const next = schoolIndex ? schoolIndex.resolve(selectedSchool.key, year) : null;
        if (!next) {
            return false;
        }
        if (next !== selectedSchool) {
            selectSchool(next);
        }
        return true;
    }

    async function loadProjects() {
        const data = await grist.docApi.fetchTable(TABLE_PROJECTS);
        const ids = columnValues(data, 'id');
        const list = [];

        for (let i = 0; i < ids.length; i += 1) {
            const row = {
                id: Number(ids[i]),
                school: Number(columnValues(data, COL_SCHOOL)[i]) || 0,
                year: text(columnValues(data, COL_YEAR)[i]),
                levels: [],
                domains: []
            };

            for (const level of levels) {
                if (toCount(columnValues(data, level.flag)[i]) > 0) {
                    row.levels.push(level.name);
                }
            }
            for (const domain of domains) {
                const value = text(columnValues(data, domain.col)[i]);
                if (value) {
                    row.domains.push({ label: domain.label, title: value });
                }
            }

            list.push(row);
        }

        projects = list;
    }

    /* ------------------------------------------------------------------
     * Colonnes réellement inscriptibles
     *
     * Le schéma peut avoir évolué depuis « Vue du code.txt ». On n'affiche
     * que les niveaux et domaines dont la colonne existe et n'est pas une
     * formule, plutôt que de laisser l'enregistrement échouer.
     * ---------------------------------------------------------------- */

    async function restrictToWritableColumns() {
        const writable = await window.GristColumns.fetchDataColumnIds(TABLE_PROJECTS);
        if (!writable) {
            return null;
        }

        const available = new Set(writable);

        for (const colId of [COL_SCHOOL, COL_YEAR]) {
            if (!available.has(colId)) {
                throw new Error(`La colonne « ${colId} » est absente ou calculée dans ${TABLE_PROJECTS}.`);
            }
        }

        levels = LEVELS.filter((level) => available.has(level.flag));
        domains = DOMAINS.filter((domain) => available.has(domain.col));

        if (levels.length === 0 || domains.length === 0) {
            throw new Error(`Aucune colonne de niveau ou de domaine inscriptible dans ${TABLE_PROJECTS}.`);
        }

        const missing = [
            ...LEVELS.filter((level) => !available.has(level.flag)).map((level) => level.flag),
            ...DOMAINS.filter((domain) => !available.has(domain.col)).map((domain) => domain.col)
        ];

        return missing;
    }

    /* ------------------------------------------------------------------
     * Année scolaire
     * ---------------------------------------------------------------- */

    async function buildYearOptions() {
        let choices = [];

        const defs = await window.GristColumns.fetchColumnDefs(TABLE_PROJECTS, [COL_YEAR]);
        if (defs && defs[COL_YEAR] && defs[COL_YEAR].choices.length > 0) {
            choices = defs[COL_YEAR].choices;
        } else {
            // Repli : les valeurs déjà saisies, complétées par l'année en cours.
            const seen = new Set(projects.map((row) => row.year).filter(Boolean));
            seen.add(currentSchoolYear());
            choices = [...seen].sort();
        }

        el.yearSelect.textContent = '';
        for (const choice of choices) {
            const option = document.createElement('option');
            option.value = choice;
            option.textContent = choice;
            el.yearSelect.appendChild(option);
        }

        const current = currentSchoolYear();
        el.yearSelect.value = choices.includes(current) ? current : choices[choices.length - 1] || '';

        if (!choices.includes(current)) {
            setStatus(`L'année ${current} n'est pas proposée par la colonne ${COL_YEAR} du document.`, 'warn');
        }
    }

    /* ------------------------------------------------------------------
     * Cases à cocher
     * ---------------------------------------------------------------- */

    function buildChips(container, items, nameOf, labelOf) {
        container.textContent = '';

        for (const item of items) {
            const chip = document.createElement('label');
            chip.className = 'chip';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = nameOf(item);
            input.addEventListener('change', resetDuplicateGuard);

            const caption = document.createElement('span');
            caption.textContent = labelOf(item);

            chip.append(input, caption);
            container.appendChild(chip);
        }
    }

    function buildLevelChips() {
        buildChips(el.levels, levels, (level) => level.name, (level) => level.name);
        updateLevelCounts();
    }

    // Effectifs de l'école retenue, affichés à côté de chaque niveau. Un
    // niveau sans élève ne produirait rien dans Niveau_x_ : la formule lit
    // l'effectif, qui reste vide quand il vaut zéro.
    function updateLevelCounts() {
        const chips = [...el.levels.querySelectorAll('.chip')];

        chips.forEach((chip, index) => {
            const level = levels[index];
            const existing = chip.querySelector('.chip-count');
            if (existing) existing.remove();
            chip.classList.remove('chip-empty');

            if (!selectedSchool || !level.count) {
                return;
            }

            const count = selectedSchool.counts[level.name] || 0;
            const badge = document.createElement('small');
            badge.className = 'chip-count';
            badge.textContent = count > 0 ? String(count) : '0';
            chip.appendChild(badge);

            if (count === 0) {
                chip.classList.add('chip-empty');
            }
        });

        el.levelsHint.textContent = selectedSchool
            ? `Effectifs de l'école en ${selectedSchool.year || 'année non renseignée'}.`
            : 'Sélectionnez une école pour voir ses effectifs par niveau.';
        el.countsBtn.hidden = !selectedSchool || countLevels().length === 0;
    }

    /* ------------------------------------------------------------------
     * Recherche d'école
     * ---------------------------------------------------------------- */

    function search(query) {
        const tokens = normalize(query).split(' ').filter(Boolean);
        if (tokens.length === 0) {
            return [];
        }

        const matches = schools.filter((school) => tokens.every((token) => school.haystack.includes(token)));
        const first = tokens[0];

        // Les libellés commençant par la recherche passent devant : on tape
        // le début d'un nom de commune bien plus souvent que son milieu.
        matches.sort((a, b) => {
            const aStarts = a.sortKey.startsWith(first) || normalize(a.Nom).startsWith(first);
            const bStarts = b.sortKey.startsWith(first) || normalize(b.Nom).startsWith(first);
            if (aStarts !== bStarts) {
                return aStarts ? -1 : 1;
            }
            return a.sortKey.localeCompare(b.sortKey, 'fr');
        });

        return matches.slice(0, MAX_RESULTS);
    }

    function closeList() {
        el.schoolList.hidden = true;
        el.schoolList.textContent = '';
        el.schoolInput.setAttribute('aria-expanded', 'false');
        el.schoolInput.removeAttribute('aria-activedescendant');
        activeOption = -1;
        results = [];
    }

    function renderResults(query) {
        results = search(query);
        el.schoolList.textContent = '';
        activeOption = -1;

        if (normalize(query).length === 0) {
            closeList();
            return;
        }

        if (results.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'combo-empty';
            empty.textContent = 'Aucune école ne correspond.';
            el.schoolList.appendChild(empty);
        } else {
            results.forEach((school, index) => {
                const option = document.createElement('li');
                option.className = 'combo-option';
                option.id = `school-option-${index}`;
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', 'false');

                const name = document.createElement('strong');
                name.textContent = school.label || school.UAI;
                const meta = document.createElement('span');
                meta.textContent = school.meta;

                option.append(name, meta);
                option.addEventListener('mouseenter', () => highlightOption(index));
                option.addEventListener('mousedown', (event) => {
                    // mousedown plutôt que click : le blur de l'input fermerait
                    // la liste avant que le click ne soit délivré.
                    event.preventDefault();
                    selectSchool(school);
                });
                el.schoolList.appendChild(option);
            });
        }

        el.schoolList.hidden = false;
        el.schoolInput.setAttribute('aria-expanded', 'true');

        // Le premier résultat est toujours mis en avant : ce que valide
        // Entrée est ainsi visible avant d'appuyer.
        highlightOption(0);
    }

    function highlightOption(index) {
        const options = [...el.schoolList.querySelectorAll('.combo-option')];
        if (options.length === 0) {
            return;
        }

        activeOption = (index + options.length) % options.length;

        options.forEach((option, i) => {
            const active = i === activeOption;
            option.classList.toggle('is-active', active);
            option.setAttribute('aria-selected', String(active));
            if (active) {
                option.scrollIntoView({ block: 'nearest' });
                el.schoolInput.setAttribute('aria-activedescendant', option.id);
            }
        });
    }

    function selectSchool(school) {
        selectedSchool = school;
        el.schoolInput.value = '';
        closeList();

        el.schoolSelected.textContent = '';
        const info = document.createElement('div');

        const name = document.createElement('div');
        name.className = 'school-card-name';
        name.textContent = school.label || school.UAI;

        const meta = document.createElement('div');
        meta.className = 'school-card-meta';
        meta.textContent = [school.Commune, school.UAI, school.Circo].filter(Boolean).join(' · ');

        info.append(name, meta);

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'school-clear';
        clear.textContent = 'Changer';
        clear.addEventListener('click', clearSchool);

        el.schoolSelected.append(info, clear);
        el.schoolSelected.hidden = false;

        setFieldError(el.schoolError, el.schoolInput, '');
        updateLevelCounts();
        renderExisting();
        resetDuplicateGuard();
    }

    function clearSchool() {
        selectedSchool = null;
        el.schoolSelected.hidden = true;
        el.schoolSelected.textContent = '';
        updateLevelCounts();
        renderExisting();
        resetDuplicateGuard();
        el.schoolInput.focus();
    }

    /* ------------------------------------------------------------------
     * Projets déjà saisis
     * ---------------------------------------------------------------- */

    // Projets de l'école l'année choisie, quelle que soit la ligne de Ecoles
    // qu'ils référencent : l'école est reconnue par son UAI.
    function existingRows() {
        if (!selectedSchool) {
            return [];
        }
        const year = el.yearSelect.value;
        return projects.filter((row) => {
            const school = schoolIndex ? schoolIndex.byId.get(row.school) : null;
            return school && school.key === selectedSchool.key && row.year === year;
        });
    }

    function renderExisting() {
        if (!selectedSchool) {
            el.existingCard.hidden = true;
            return;
        }

        const rows = existingRows();
        const year = el.yearSelect.value;

        el.existingTitle.textContent = 'Déjà saisi pour cette école';
        el.existingSubtitle.textContent = `${selectedSchool.label || selectedSchool.UAI} — ${year}`;
        el.existingList.textContent = '';

        if (rows.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'existing-empty';
            empty.textContent = 'Aucun projet enregistré pour cette année.';
            el.existingList.appendChild(empty);
            el.existingCard.hidden = false;
            return;
        }

        for (const row of rows) {
            const block = document.createElement('div');
            block.className = 'existing-row';

            const titles = [...new Set(row.domains.map((domain) => domain.title))];
            const title = document.createElement('div');
            title.className = 'existing-title';
            title.textContent = titles.join(' / ') || 'Sans intitulé';
            block.appendChild(title);

            const meta = document.createElement('div');
            meta.className = 'existing-meta';
            meta.textContent = row.levels.length > 0 ? row.levels.join(', ') : 'Aucun niveau renseigné';
            block.appendChild(meta);

            if (row.domains.length > 0) {
                const list = document.createElement('div');
                list.className = 'existing-domains';
                for (const domain of row.domains) {
                    const tag = document.createElement('span');
                    tag.className = 'existing-domain';
                    tag.textContent = domain.label;
                    list.appendChild(tag);
                }
                block.appendChild(list);
            }

            el.existingList.appendChild(block);
        }

        el.existingCard.hidden = false;
    }

    /* ------------------------------------------------------------------
     * Validation et enregistrement
     * ---------------------------------------------------------------- */

    function validate() {
        clearErrors();

        const title = el.titleInput.value.trim();
        const checkedLevels = checkedValues(el.levels);
        const checkedDomains = checkedValues(el.domains);
        let firstInvalid = null;

        if (!selectedSchool) {
            setFieldError(el.schoolError, el.schoolInput, 'Sélectionnez une école dans la liste.');
            firstInvalid = firstInvalid || el.schoolInput;
        }
        if (title.length === 0) {
            setFieldError(el.titleError, el.titleInput, 'L\'intitulé du projet est obligatoire.');
            firstInvalid = firstInvalid || el.titleInput;
        }
        if (checkedLevels.length === 0) {
            setFieldError(el.levelsError, null, 'Cochez au moins un niveau.');
            firstInvalid = firstInvalid || el.levels.querySelector('input');
        }
        if (checkedDomains.length === 0) {
            setFieldError(el.domainsError, null, 'Cochez au moins un domaine.');
            firstInvalid = firstInvalid || el.domains.querySelector('input');
        }

        if (firstInvalid) {
            firstInvalid.focus();
            return null;
        }

        return { title: title.slice(0, MAX_TITLE_LENGTH), levels: checkedLevels, domains: checkedDomains };
    }

    function findDuplicate(entry) {
        const wanted = normalize(entry.title);
        const domainLabels = new Set(
            domains.filter((domain) => entry.domains.includes(domain.col)).map((domain) => domain.label)
        );

        return existingRows().some((row) =>
            row.domains.some((domain) => domainLabels.has(domain.label) && normalize(domain.title) === wanted)
        );
    }

    function buildFields(entry) {
        const fields = {};

        fields[COL_SCHOOL] = selectedSchool.id;
        fields[COL_YEAR] = el.yearSelect.value;

        for (const domain of entry.domains) {
            fields[domain] = entry.title;
        }
        for (const level of levels) {
            if (entry.levels.includes(level.name)) {
                fields[level.flag] = 1;
            }
        }

        return fields;
    }

    async function onSubmit(event) {
        event.preventDefault();

        if (submitting) {
            return;
        }

        const entry = validate();
        if (!entry) {
            setStatus('Le formulaire est incomplet.', 'error');
            return;
        }

        if (!pendingDuplicate && findDuplicate(entry)) {
            pendingDuplicate = true;
            el.submitBtn.textContent = 'Enregistrer quand même';
            el.submitBtn.classList.add('btn-warn');
            setStatus('Un projet du même intitulé existe déjà pour cette école, cette année et ce domaine.', 'warn');
            return;
        }

        submitting = true;
        el.submitBtn.disabled = true;
        setStatus('Enregistrement en cours…', 'info');

        try {
            await grist.docApi.applyUserActions([['AddRecord', TABLE_PROJECTS, null, buildFields(entry)]]);
            await loadProjects();

            // L'école et l'année restent en place : les projets se saisissent
            // le plus souvent par paquets pour un même établissement.
            el.titleInput.value = '';
            uncheckAll(el.levels);
            uncheckAll(el.domains);
            clearErrors();
            renderExisting();

            resetDuplicateGuard();
            setStatus(`Projet « ${entry.title} » enregistré.`, 'success');
            el.titleInput.focus();
        } catch (error) {
            console.error(error);
            setStatus('Enregistrement impossible : ' + ((error && error.message) ? error.message : error), 'error');
        } finally {
            submitting = false;
            el.submitBtn.disabled = false;
        }
    }

    /* ------------------------------------------------------------------
     * Effectifs de l'école
     *
     * Modifie la ligne de Ecoles de l'école retenue pour l'année choisie. Les
     * projets de cette année référencent cette ligne : leurs colonnes
     * d'effectifs suivent. Ceux des autres années ne changent pas.
     * ---------------------------------------------------------------- */

    function countLevels() {
        return LEVELS.filter((level) => level.count && writableCountColumns.has(level.count));
    }

    function openCountsDialog() {
        if (!selectedSchool) {
            return;
        }

        const year = el.yearSelect.value;
        el.countsSubtitle.textContent = `${selectedSchool.label || selectedSchool.UAI} — ${selectedSchool.year || 'année non renseignée'}`;

        // Ligne d'une autre année : la table ne connaît pas l'année choisie
        // (antérieure à la colonne Annee). On le dit plutôt que de le taire.
        const otherYear = selectedSchool.year !== year;
        el.countsNote.hidden = !otherYear;
        el.countsNote.textContent = otherYear
            ? `La table des écoles n'a pas de ligne pour ${year} : ce sont les effectifs de ${selectedSchool.year || 'la ligne sans année'} qui seront modifiés.`
            : '';

        el.countsGrid.textContent = '';
        for (const level of countLevels()) {
            const id = `count-${level.name}`;
            const field = document.createElement('div');
            field.className = 'count-field';

            const label = document.createElement('label');
            label.htmlFor = id;
            label.textContent = level.name;

            const input = document.createElement('input');
            input.type = 'number';
            input.id = id;
            input.name = level.count;
            input.min = '0';
            input.max = String(MAX_COUNT);
            input.step = '1';
            input.inputMode = 'numeric';
            const current = selectedSchool.counts[level.name];
            input.value = current === null || current === undefined ? '' : String(current);
            input.addEventListener('input', () => {
                input.classList.remove('is-invalid');
                setFieldError(el.countsError, null, '');
            });

            field.append(label, input);
            el.countsGrid.appendChild(field);
        }

        setFieldError(el.countsError, null, '');
        el.countsSave.disabled = false;
        el.countsDialog.showModal();
        const first = el.countsGrid.querySelector('input');
        if (first) {
            first.focus();
            first.select();
        }
    }

    function readCounts() {
        const fields = {};
        let firstInvalid = null;

        for (const input of el.countsGrid.querySelectorAll('input')) {
            const raw = input.value.trim();
            // Un champ number rejeté par le navigateur (« 12a ») rend une valeur
            // vide : badInput le distingue d'un champ réellement vide.
            if (raw === '' && !input.validity.badInput) {
                fields[input.name] = null;
                continue;
            }
            if (/^\d{1,3}$/.test(raw) && Number(raw) <= MAX_COUNT) {
                fields[input.name] = Number(raw);
                continue;
            }
            input.classList.add('is-invalid');
            firstInvalid = firstInvalid || input;
        }

        if (firstInvalid) {
            setFieldError(el.countsError, null, `Nombre entier entre 0 et ${MAX_COUNT} attendu, ou case vide.`);
            firstInvalid.focus();
            return null;
        }
        return fields;
    }

    async function onCountsSubmit(event) {
        event.preventDefault();
        if (savingCounts || !selectedSchool) {
            return;
        }

        const fields = readCounts();
        if (!fields) {
            return;
        }

        const school = selectedSchool;
        savingCounts = true;
        el.countsSave.disabled = true;

        try {
            await grist.docApi.applyUserActions([['UpdateRecord', TABLE_SCHOOLS, school.id, fields]]);
            await loadSchools();
            // Ramène l'école retenue sur sa ligne relue, avec les nouveaux effectifs.
            refreshSchoolList();

            el.countsDialog.close();
            setStatus(`Effectifs enregistrés pour ${school.label || school.UAI} (${school.year || 'sans année'}).`, 'success');
        } catch (error) {
            console.error(error);
            setFieldError(el.countsError, null,
                'Enregistrement impossible : ' + ((error && error.message) ? error.message : error));
            el.countsSave.disabled = false;
        } finally {
            savingCounts = false;
        }
    }

    function onReset() {
        clearSchool();
        el.titleInput.value = '';
        uncheckAll(el.levels);
        uncheckAll(el.domains);
        clearErrors();
        resetDuplicateGuard();
        setStatus('', null);
    }

    /* ------------------------------------------------------------------
     * Démarrage
     * ---------------------------------------------------------------- */

    function cacheElements() {
        const ids = {
            form: 'project-form',
            schoolInput: 'school-input',
            schoolList: 'school-list',
            schoolSelected: 'school-selected',
            schoolError: 'school-error',
            yearSelect: 'year-select',
            titleInput: 'title-input',
            titleError: 'title-error',
            levels: 'levels',
            levelsHint: 'levels-hint',
            levelsError: 'levels-error',
            domains: 'domains',
            domainsError: 'domains-error',
            submitBtn: 'submit-btn',
            resetBtn: 'reset-btn',
            status: 'status',
            existingCard: 'existing-card',
            existingTitle: 'existing-title',
            existingSubtitle: 'existing-subtitle',
            existingList: 'existing-list',
            bootError: 'boot-error',
            bootErrorText: 'boot-error-text',
            countsBtn: 'counts-btn',
            countsDialog: 'counts-dialog',
            countsForm: 'counts-form',
            countsSubtitle: 'counts-subtitle',
            countsNote: 'counts-note',
            countsGrid: 'counts-grid',
            countsError: 'counts-error',
            countsSave: 'counts-save',
            countsCancel: 'counts-cancel'
        };

        for (const [key, id] of Object.entries(ids)) {
            el[key] = document.getElementById(id);
        }
    }

    function bindEvents() {
        el.schoolInput.addEventListener('input', () => {
            renderResults(el.schoolInput.value);
            resetDuplicateGuard();
        });

        el.schoolInput.addEventListener('focus', () => {
            if (el.schoolInput.value) {
                renderResults(el.schoolInput.value);
            }
        });

        el.schoolInput.addEventListener('blur', () => {
            setTimeout(closeList, 120);
        });

        el.schoolInput.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (el.schoolList.hidden) {
                    renderResults(el.schoolInput.value);
                } else {
                    highlightOption(activeOption + 1);
                }
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                highlightOption(activeOption - 1);
            } else if (event.key === 'Enter') {
                // Entrée ne doit jamais envoyer le formulaire depuis ce champ :
                // elle retient l'école mise en avant.
                event.preventDefault();
                if (!el.schoolList.hidden && results[activeOption]) {
                    selectSchool(results[activeOption]);
                }
            } else if (event.key === 'Escape') {
                closeList();
            }
        });

        el.yearSelect.addEventListener('change', () => {
            const previous = selectedSchool;
            if (!refreshSchoolList()) {
                // Une école fermée ou pas encore ouverte ne peut pas recevoir de
                // projet cette année-là.
                clearSchool();
                setStatus(`${previous.label || previous.UAI} n'existe pas dans la table des écoles en ${el.yearSelect.value}.`, 'warn');
            } else {
                updateLevelCounts();
                renderExisting();
            }
            resetDuplicateGuard();
        });

        el.titleInput.addEventListener('input', resetDuplicateGuard);

        el.form.addEventListener('submit', onSubmit);
        el.resetBtn.addEventListener('click', onReset);

        el.countsBtn.addEventListener('click', openCountsDialog);
        el.countsForm.addEventListener('submit', onCountsSubmit);
        el.countsCancel.addEventListener('click', () => el.countsDialog.close());
        // Clic sur le fond assombri : la cible est alors le <dialog> lui-même.
        el.countsDialog.addEventListener('click', (event) => {
            if (event.target === el.countsDialog) {
                el.countsDialog.close();
            }
        });
        el.countsDialog.addEventListener('close', () => {
            if (!el.countsBtn.hidden) {
                el.countsBtn.focus();
            }
        });
    }

    async function init() {
        cacheElements();

        if (typeof grist === 'undefined' || !grist.docApi) {
            bootError('Cette page doit être ouverte comme widget personnalisé dans Grist.');
            return;
        }
        if (!window.GristColumns || !window.SearchText || !window.SchoolYears) {
            bootError('Les modules partagés du dossier shared ne se sont pas chargés.');
            return;
        }

        grist.ready({ requiredAccess: 'full' });

        try {
            const missing = await restrictToWritableColumns();

            let created = null;
            try {
                created = await window.SchoolYears.ensureYear();
            } catch (error) {
                console.warn('Année scolaire en cours non créée dans la table des écoles.', error);
            }

            const schoolColumns = await window.GristColumns.fetchDataColumnIds(TABLE_SCHOOLS);
            writableCountColumns = new Set(schoolColumns || []);

            await loadSchools();
            await loadProjects();
            await buildYearOptions();
            refreshSchoolList();

            buildLevelChips();
            buildChips(el.domains, domains, (domain) => domain.col, (domain) => domain.label);
            bindEvents();

            if (schools.length === 0) {
                setStatus(`Aucune école lisible dans la table ${TABLE_SCHOOLS} pour ${el.yearSelect.value}.`, 'error');
            } else if (created && created.created > 0) {
                setStatus(`Année ${created.year} créée : ${created.created} écoles reprises de ${created.sourceYear}, effectifs à saisir.`, 'info');
            } else if (missing && missing.length > 0) {
                setStatus(`Colonnes absentes ou calculées, ignorées : ${missing.join(', ')}.`, 'warn');
            }
        } catch (error) {
            console.error(error);
            bootError((error && error.message) ? error.message : String(error));
        }
    }

    document.addEventListener('DOMContentLoaded', init);

})();
