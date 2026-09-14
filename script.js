(function () {
    "use strict";

    /* ---------------------------------------------------------------
     * Référentiel des écoles : table lue en dehors du mappage du widget,
     * afin d'afficher aussi les écoles qui n'ont aucune ligne de projet.
     * Une ligne par école et par année scolaire (voir shared/school-years.js).
     * Adapter ces constantes si la table ou ses colonnes sont renommées.
     * ------------------------------------------------------------- */
    const SCHOOLS_TABLE_ID = "Ecoles";
    const SCHOOLS_FIELDS = {
        uai: "UAI",
        year: "Annee",
        name: "Nom",
        complement: "Complement",
        commune: "Commune",
        latitude: "Latitude",
        longitude: "Longitude",
    };

    /* ---------------------------------------------------------------
     * Niveaux cochés : table source du widget, lue elle aussi hors mappage.
     * Les colonnes mappées dans Niveaux (TPS, PS…) sont des formules qui
     * reprennent l'effectif de l'école, vides tant qu'il n'est pas saisi. Le
     * drapeau posé par la saisie (TPS2, PS2…) dit, lui, si le projet concerne
     * le niveau. Grist ne transmet au widget que les colonnes mappées, d'où
     * cette lecture. Adapter si la table ou ses colonnes sont renommées.
     * ------------------------------------------------------------- */
    const PROJECTS_TABLE_ID = "Projets_par_ecole";
    const LEVEL_FLAGS = {
        TPS: "TPS2", PS: "PS2", MS: "MS2", GS: "GS2", CP: "CP2",
        CE1: "CE1_2", CE2: "CE2_2", CM1: "CM1_2", CM2: "CM2_2", ASH: "ASH",
    };

    const ALL_YEARS = "__all__";
    const ALL_YEARS_LABEL = "Toutes les années";
    const HIDDEN_ONLY_TITLE_ON = "Afficher seulement les écoles sans projet";
    const HIDDEN_ONLY_TITLE_OFF = "Afficher les écoles avec projet";
    const HOVER_OPEN_DELAY_MS = 850;
    const HOVER_CLOSE_DELAY_MS = 300;
    const NO_CONFIG_DELAY_MS = 500;
    const POPUP_MAX_WIDTH = 420;
    const COINCIDENT_OFFSET_DEG = 0.00025;
    // Emprise approchée de Limites_Lozere.geojson : cadre la carte dès sa
    // création, avant que le fichier ne soit chargé et donne l'emprise exacte.
    const DEPARTMENT_FALLBACK_BOUNDS = [[44.11, 2.98], [44.98, 4.0]];
    const DEPARTMENT_PADDING = [12, 12];
    // Crans de zoom d'un quart de niveau (1 par défaut) : le cadrage initial
    // colle au département au lieu de retomber sur le niveau entier inférieur.
    const ZOOM_SNAP = 0.25;
    const DEFAULT_NO_CONFIG_MESSAGE =
        "Veuillez configurer les colonnes dans le panneau du widget Grist (Nom, Latitude, Longitude, Domaines, Niveaux). " +
        "Année scolaire et École sont facultatives mais recommandées.";

    let map = null;
    let markersLayer = null;
    let departmentLayer = null;
    let circoLayer = null;
    let overlaysLoaded = false;
    let userMovedMap = false;
    let noConfigTimer = null;

    let colName = null;
    let colLat = null;
    let colLng = null;
    let colSchool = null;
    let colYear = null;
    let colsPrimary = [];
    let colsSecondary = [];

    let allRows = [];
    let schoolIndex = null;
    let schoolsRequested = false;
    let schoolsRefreshQueued = false;
    // rowId → niveaux (colonnes de Niveaux) cochés ; null si illisible.
    let levelFlags = null;
    let levelFlagColumns = new Set();
    let levelFlagsRequest = 0;
    let entries = [];
    let years = [];
    let selectedYear = null;

    let activePrimary = new Set();
    let activeSecondary = new Set();
    let showHidden = false;
    let showHiddenOnly = false;

    let hoverPopup = null;
    let hoverOpenTimer = null;
    let hoverCloseTimer = null;
    let pointerIsCoarse = false;

    let modalEntryKey = null;
    let modalApplyFilters = false;
    let lastFocusedBeforeModal = null;
    let lastFocusedBeforeHelp = null;

    /* ---------------------------------------------------------------
     * Utilitaires
     * ------------------------------------------------------------- */

    function toArray(value) {
        if (Array.isArray(value)) {
            return value.filter((v) => typeof v === "string" && v.length > 0);
        }
        if (typeof value === "string" && value.length > 0) {
            return [value];
        }
        return [];
    }

    function arraysEqual(a, b) {
        if (a.length !== b.length) {
            return false;
        }
        return a.every((value, index) => value === b[index]);
    }

    function escapeHtml(str) {
        return String(str ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function isNonEmpty(val) {
        return val !== null && val !== undefined && val !== "" && val !== 0 && val !== "0";
    }

    function isNumericNonZero(val) {
        const n = Number(val);
        return !isNaN(n) && n > 0;
    }

    function normalizeFeatureName(value) {
        return String(value ?? "").replace(/\s+/g, " ").trim();
    }

    function currentSchoolYear() {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        return month <= 7 ? `${year - 1}-${year}` : `${year}-${year + 1}`;
    }

    function yearLabel(value) {
        return !value || value === ALL_YEARS ? ALL_YEARS_LABEL : value;
    }

    /* ---------------------------------------------------------------
     * Message de configuration
     * ------------------------------------------------------------- */

    function showNoConfigMessage(message) {
        const panel = document.getElementById("no-config");
        const text = panel.querySelector("span");
        if (text) {
            text.textContent = message;
        }
        panel.classList.remove("hidden");
    }

    function hideNoConfigMessage() {
        if (noConfigTimer) {
            clearTimeout(noConfigTimer);
            noConfigTimer = null;
        }
        document.getElementById("no-config").classList.add("hidden");
    }

    function scheduleNoConfigMessage(message) {
        if (noConfigTimer) {
            clearTimeout(noConfigTimer);
        }
        noConfigTimer = setTimeout(() => {
            noConfigTimer = null;
            showNoConfigMessage(message);
        }, NO_CONFIG_DELAY_MS);
    }

    /* ---------------------------------------------------------------
     * Carte et couches de fond
     * ------------------------------------------------------------- */

    async function loadMapOverlays() {
        if (!map || overlaysLoaded) {
            return;
        }

        overlaysLoaded = true;

        try {
            const [departmentResponse, circoResponse] = await Promise.all([
                fetch("./Limites_Lozere.geojson"),
                fetch("./Limites_Circos.geojson"),
            ]);

            if (!departmentResponse.ok || !circoResponse.ok) {
                throw new Error("Impossible de charger les couches GeoJSON.");
            }

            const [departmentData, circoData] = await Promise.all([
                departmentResponse.json(),
                circoResponse.json(),
            ]);

            departmentLayer = L.geoJSON(departmentData, {
                pane: "overlayPane",
                style: {
                    color: "#1f2937",
                    weight: 2,
                    opacity: 0.85,
                    fillColor: "#93c5fd",
                    fillOpacity: 0.08,
                },
            }).addTo(map);

            circoLayer = L.geoJSON(circoData, {
                pane: "overlayPane",
                style: (feature) => {
                    const name = normalizeFeatureName(feature?.properties?.Name);

                    if (name.includes("Mende")) {
                        return { color: "#3bb91c", weight: 3, opacity: 0.85, dashArray: "8 6" };
                    }

                    if (name.includes("Marvejols")) {
                        return { color: "#0f766e", weight: 3, opacity: 0.85, dashArray: "8 6" };
                    }

                    return { color: "#7c3aed", weight: 3, opacity: 0.85, dashArray: "8 6" };
                },
                onEachFeature: (feature, layer) => {
                    const name = normalizeFeatureName(feature?.properties?.Name);

                    if (name) {
                        layer.bindPopup(`<strong>${escapeHtml(name)}</strong>`);
                    }
                },
            }).addTo(map);

            fitDepartment();
        } catch (error) {
            overlaysLoaded = false;
            console.error(error);
        }
    }

    function fitDepartment() {
        if (!map || userMovedMap) {
            return;
        }
        const bounds = departmentLayer && departmentLayer.getBounds().isValid()
            ? departmentLayer.getBounds()
            : DEPARTMENT_FALLBACK_BOUNDS;
        map.invalidateSize({ animate: false });
        map.fitBounds(bounds, { padding: DEPARTMENT_PADDING, animate: false });
    }

    function refreshMapSize() {
        if (!map) {
            return;
        }
        // Tant que l'utilisateur n'a pas bougé la carte, un changement de taille
        // du widget (fréquent pendant le chargement dans Grist) recadre sur le
        // département au lieu de simplement conserver le centre.
        if (userMovedMap) {
            map.invalidateSize();
        } else {
            fitDepartment();
        }
    }

    function watchUserMoves() {
        const container = map.getContainer();
        const markMoved = () => {
            userMovedMap = true;
        };
        for (const type of ["pointerdown", "wheel", "keydown"]) {
            container.addEventListener(type, markMoved, { passive: true });
        }
    }

    function ensureMap() {
        if (map) {
            return true;
        }
        if (typeof L === "undefined") {
            showNoConfigMessage(
                "La bibliotheque de carte (Leaflet) ne s'est pas chargee. Verifiez le reseau/CSP puis rechargez le widget."
            );
            return false;
        }
        map = L.map("map", { zoomSnap: ZOOM_SNAP });
        fitDepartment();
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        markersLayer = L.layerGroup().addTo(map);
        watchUserMoves();
        void loadMapOverlays();
        setTimeout(refreshMapSize, 0);
        return true;
    }

    /* ---------------------------------------------------------------
     * Filtres et appartenance des lignes
     * ------------------------------------------------------------- */

    function rowYear(row) {
        if (!colYear) {
            return "";
        }
        const value = row[colYear];
        return typeof value === "string" ? value : String(value ?? "");
    }

    function rowInYear(row, year) {
        if (!year || year === ALL_YEARS || !colYear) {
            return true;
        }
        return rowYear(row) === year;
    }

    function rowHasAnyProject(row) {
        return colsPrimary.some((col) => isNonEmpty(row[col]));
    }

    // Le projet concerne-t-il ce niveau ? Case cochée si elle est connue,
    // sinon effectif non nul (colonne sans drapeau, table illisible, ligne
    // arrivée avant la relecture des drapeaux).
    function rowHasLevel(row, col) {
        const checked = levelFlags && levelFlagColumns.has(col) ? levelFlags.get(Number(row.id)) : null;
        if (checked && checked.has(col)) {
            return true;
        }
        return isNumericNonZero(row[col]);
    }

    function rowMatchesFilters(row) {
        const primaryCols = [...activePrimary];
        const secondaryCols = [...activeSecondary];

        if (primaryCols.length === 0 || secondaryCols.length === 0) {
            return false;
        }

        const hasPrimary = primaryCols.some((col) => isNonEmpty(row[col]));
        const hasSecondary = secondaryCols.some((col) => rowHasLevel(row, col));

        return hasPrimary && hasSecondary;
    }

    function matchingRows(entry) {
        return entry.rows.filter((row) => rowInYear(row, selectedYear) && rowMatchesFilters(row));
    }

    function entryIsVisible(entry) {
        if (entry.matchCount > 0) {
            return !showHiddenOnly;
        }
        return showHidden;
    }

    /* ---------------------------------------------------------------
     * Référentiel des écoles
     * ------------------------------------------------------------- */

    function buildSchoolName(data, index) {
        const parts = [];
        for (const key of [SCHOOLS_FIELDS.name, SCHOOLS_FIELDS.complement, SCHOOLS_FIELDS.commune]) {
            const column = data[key];
            const value = Array.isArray(column) ? column[index] : null;
            if (typeof value === "string" && value.trim().length > 0) {
                parts.push(value.trim());
            }
        }
        return parts.join(" ");
    }

    async function loadSchools() {
        if (typeof grist === "undefined" || !grist.docApi || typeof grist.docApi.fetchTable !== "function") {
            return;
        }

        try {
            const data = await grist.docApi.fetchTable(SCHOOLS_TABLE_ID);
            const ids = data?.id;
            const lats = data?.[SCHOOLS_FIELDS.latitude];
            const lngs = data?.[SCHOOLS_FIELDS.longitude];
            const uais = data?.[SCHOOLS_FIELDS.uai];
            const schoolYears = data?.[SCHOOLS_FIELDS.year];

            if (!Array.isArray(ids) || !Array.isArray(lats) || !Array.isArray(lngs)) {
                return;
            }

            const records = [];
            for (let index = 0; index < ids.length; index += 1) {
                const lat = parseFloat(lats[index]);
                const lng = parseFloat(lngs[index]);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                    continue;
                }
                records.push({
                    id: Number(ids[index]),
                    uai: Array.isArray(uais) ? uais[index] : "",
                    year: Array.isArray(schoolYears) ? schoolYears[index] : "",
                    name: buildSchoolName(data, index),
                    lat,
                    lng,
                });
            }

            schoolIndex = records.length > 0 ? window.SchoolYears.buildIndex(records) : null;
        } catch (error) {
            // Table absente ou accès refusé : la carte se rabat sur les lignes de projets.
            console.warn("Référentiel des écoles indisponible.", error);
            schoolIndex = null;
        }
    }

    async function ensureSchools() {
        if (schoolsRequested) {
            return;
        }
        schoolsRequested = true;
        try {
            // Crée les lignes de l'année en cours avant la première lecture.
            await window.SchoolYears.ensureYear();
        } catch (error) {
            console.warn("Année scolaire en cours non créée dans la table des écoles.", error);
        }
        await loadSchools();
        rebuild();
    }

    async function loadLevelFlags() {
        const request = ++levelFlagsRequest;
        if (typeof grist === "undefined" || !grist.docApi || typeof grist.docApi.fetchTable !== "function") {
            return;
        }

        try {
            const data = await grist.docApi.fetchTable(PROJECTS_TABLE_ID);
            const ids = Array.isArray(data?.id) ? data.id : [];
            const columns = new Set();
            const flags = new Map(ids.map((id) => [Number(id), new Set()]));

            for (const [level, flagCol] of Object.entries(LEVEL_FLAGS)) {
                const values = data?.[flagCol];
                if (!Array.isArray(values)) {
                    continue;
                }
                columns.add(level);
                values.forEach((value, index) => {
                    if (isNumericNonZero(value) || value === true) {
                        flags.get(Number(ids[index])).add(level);
                    }
                });
            }

            if (request === levelFlagsRequest) {
                levelFlags = flags;
                levelFlagColumns = columns;
            }
        } catch (error) {
            // Table renommée ou accès refusé : les effectifs font foi.
            console.warn("Niveaux cochés indisponibles.", error);
            if (request === levelFlagsRequest) {
                levelFlags = null;
                levelFlagColumns = new Set();
            }
        }
    }

    function queueSchoolsRefresh() {
        // Une seule tentative par lot d'enregistrements, sinon une référence
        // orpheline relancerait indéfiniment la lecture du référentiel.
        if (schoolsRefreshQueued) {
            return;
        }
        schoolsRefreshQueued = true;
        loadSchools().then(rebuild);
    }

    /* ---------------------------------------------------------------
     * Construction des points de la carte
     * ------------------------------------------------------------- */

    function positionKey(lat, lng) {
        return `pos:${lat.toFixed(6)},${lng.toFixed(6)}`;
    }

    // Identifiant de ligne d'une Référence, sous ses différentes formes :
    //  - ["R", "Ecoles", 12] : forme encodée, celle que grist.onRecords
    //    transmet avec expandRefs: false (valeur non décodée) ;
    //  - { tableId, rowId } : forme décodée (keepEncoded: false) ;
    //  - { id } ou 12 : lignes lues autrement.
    function referenceId(value) {
        if (Array.isArray(value)) {
            return value[0] === "R" && value.length >= 3 ? referenceId(value[2]) : null;
        }
        if (value && typeof value === "object") {
            return referenceId("rowId" in value ? value.rowId : value.id);
        }
        const id = Number(value);
        return Number.isFinite(id) && id > 0 ? id : null;
    }

    function buildEntries() {
        const byKey = new Map();

        const ensureEntry = (key, name, lat, lng) => {
            let entry = byKey.get(key);
            if (!entry) {
                entry = { key, name, lat, lng, dLat: lat, dLng: lng, rows: [], matchCount: 0, everHasProject: false };
                byKey.set(key, entry);
            } else if (!entry.name && name) {
                entry.name = name;
            }
            return entry;
        };

        // Écoles existant l'année affichée, avec ou sans projet. Une école a une
        // ligne par année : elle est regroupée par UAI, et sa position et son
        // nom sont ceux de l'année affichée.
        if (schoolIndex) {
            for (const school of schoolIndex.schoolsFor(selectedYear)) {
                const key = colSchool ? `school:${school.key}` : positionKey(school.lat, school.lng);
                ensureEntry(key, school.name, school.lat, school.lng);
            }
        }

        let sawUnknownReference = false;

        for (const row of allRows) {
            const lat = parseFloat(row[colLat]);
            const lng = parseFloat(row[colLng]);
            const id = colSchool ? referenceId(row[colSchool]) : null;
            const school = id !== null && schoolIndex ? schoolIndex.byId.get(id) : null;

            let key = null;
            if (school) {
                key = `school:${school.key}`;
            } else if (id !== null && schoolIndex) {
                sawUnknownReference = true;
            }

            if (!key) {
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                    continue;
                }
                key = id !== null && !schoolIndex ? `school:${id}` : positionKey(lat, lng);
            }

            let entry = byKey.get(key);
            if (!entry && school) {
                // École absente de l'année affichée (fermée depuis, par exemple) :
                // elle reste accessible par l'historique de ses projets.
                const shown = schoolIndex.resolve(school.key, selectedYear) || school;
                entry = ensureEntry(key, shown.name, shown.lat, shown.lng);
            } else if (!entry) {
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                    continue;
                }
                entry = ensureEntry(key, String(row[colName] ?? ""), lat, lng);
            }

            entry.rows.push(row);
            if (!entry.name) {
                entry.name = String(row[colName] ?? "");
            }
        }

        entries = [...byKey.values()];
        for (const entry of entries) {
            entry.everHasProject = entry.rows.some(rowHasAnyProject);
        }
        spreadCoincidentEntries(entries);

        if (sawUnknownReference) {
            // Une école a été ajoutée depuis le dernier chargement du référentiel.
            queueSchoolsRefresh();
        }
    }

    function spreadCoincidentEntries(list) {
        const byPosition = new Map();

        for (const entry of list) {
            entry.dLat = entry.lat;
            entry.dLng = entry.lng;
            const key = positionKey(entry.lat, entry.lng);
            if (!byPosition.has(key)) {
                byPosition.set(key, []);
            }
            byPosition.get(key).push(entry);
        }

        for (const group of byPosition.values()) {
            if (group.length < 2) {
                continue;
            }
            const step = (2 * Math.PI) / group.length;
            group.forEach((entry, index) => {
                const angle = step * index - Math.PI / 2;
                const lngScale = Math.max(0.2, Math.cos((entry.lat * Math.PI) / 180));
                entry.dLat = entry.lat + COINCIDENT_OFFSET_DEG * Math.sin(angle);
                entry.dLng = entry.lng + (COINCIDENT_OFFSET_DEG / lngScale) * Math.cos(angle);
            });
        }
    }

    function updateMatchCounts() {
        for (const entry of entries) {
            entry.matchCount = matchingRows(entry).length;
        }
    }

    /* ---------------------------------------------------------------
     * Sélecteur d'année scolaire
     * ------------------------------------------------------------- */

    function collectYears() {
        if (!colYear) {
            years = [];
            selectedYear = ALL_YEARS;
            return;
        }

        // Les années de la table des écoles comptent aussi : l'année en cours
        // doit être proposée avant même qu'un projet y soit saisi.
        const found = new Set(schoolIndex ? schoolIndex.years : []);
        for (const row of allRows) {
            const value = rowYear(row).trim();
            if (value.length > 0) {
                found.add(value);
            }
        }
        years = [...found].sort();
    }

    // Dernière année ayant au moins un projet : en début d'année scolaire,
    // l'année en cours est encore vide. À défaut, l'année en cours, puis la
    // plus récente.
    function defaultYear() {
        const withProjects = allRows
            .filter(rowHasAnyProject)
            .map((row) => rowYear(row).trim())
            .filter((value) => years.includes(value))
            .sort();
        if (withProjects.length > 0) {
            return withProjects[withProjects.length - 1];
        }
        const current = currentSchoolYear();
        return years.includes(current) ? current : years[years.length - 1];
    }

    function buildYearSelect() {
        const section = document.getElementById("year-section");
        const select = document.getElementById("year-select");

        if (!colYear || years.length === 0) {
            section.hidden = true;
            // Sans année connue (référentiel pas encore lu), aucun choix
            // n'est retenu : l'année par défaut sera calculée ensuite.
            selectedYear = colYear ? null : ALL_YEARS;
            return;
        }

        section.hidden = false;

        const previous = selectedYear;
        select.textContent = "";

        const optionAll = document.createElement("option");
        optionAll.value = ALL_YEARS;
        optionAll.textContent = ALL_YEARS_LABEL;
        select.appendChild(optionAll);

        for (let index = years.length - 1; index >= 0; index -= 1) {
            const option = document.createElement("option");
            option.value = years[index];
            option.textContent = years[index];
            select.appendChild(option);
        }

        if (previous === ALL_YEARS || (previous && years.includes(previous))) {
            selectedYear = previous;
        } else {
            selectedYear = defaultYear();
        }

        select.value = selectedYear;
    }

    /* ---------------------------------------------------------------
     * Marqueurs
     * ------------------------------------------------------------- */

    function colorForCount(count, min, max) {
        if (max === min) return "#1a73e8";
        const t = (count - min) / (max - min);
        // t=0 → jaune rgb(255,200,0) | t=0.5 → vert rgb(0,180,0) | t=1 → bleu rgb(26,115,232)
        let r, g, b;
        if (t <= 0.5) {
            const s = t * 2;
            r = Math.round(255 * (1 - s));
            g = Math.round(200 - 20 * s);
            b = 0;
        } else {
            const s = (t - 0.5) * 2;
            r = Math.round(26 * s);
            g = Math.round(180 * (1 - s) + 115 * s);
            b = Math.round(232 * s);
        }
        return `rgb(${r},${g},${b})`;
    }

    function markerLabel(entry) {
        if (entry.matchCount > 0) {
            const suffix = entry.matchCount > 1 ? "projets" : "projet";
            return `${entry.name} : ${entry.matchCount} ${suffix} (${yearLabel(selectedYear)})`;
        }
        if (!entry.everHasProject) {
            return `${entry.name} : aucun projet, toutes années confondues`;
        }
        const scope = selectedYear && selectedYear !== ALL_YEARS ? `en ${selectedYear}` : "pour cette sélection";
        return `${entry.name} : aucun projet ${scope}`;
    }

    function buildMarkerIcon(entry, minCount, maxCount) {
        const never = entry.matchCount === 0 && !entry.everHasProject;
        const color = entry.matchCount > 0
            ? colorForCount(entry.matchCount, minCount, maxCount)
            : (never ? "#e5e7eb" : "#9ca3af");
        const badge = entry.matchCount > 0
            ? `<span class="school-marker-badge">${escapeHtml(String(entry.matchCount))}</span>`
            : "";

        return L.divIcon({
            className: "",
            html: `<div class="school-marker${never ? " school-marker-never" : ""}" style="background:${color}">${badge}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -16],
        });
    }

    function renderMap() {
        if (!markersLayer) {
            return;
        }

        updateMatchCounts();
        closeHoverPopup();
        markersLayer.clearLayers();

        const visible = entries.filter(entryIsVisible);
        const counts = visible.map((entry) => entry.matchCount).filter((n) => n > 0);
        const minCount = counts.length > 0 ? Math.min(...counts) : 0;
        const maxCount = counts.length > 0 ? Math.max(...counts) : 0;

        for (const entry of visible) {
            const marker = L.marker([entry.dLat, entry.dLng], {
                icon: buildMarkerIcon(entry, minCount, maxCount),
                riseOnHover: true,
                keyboard: true,
            });

            marker.on("mouseover", () => {
                if (pointerIsCoarse) {
                    return;
                }
                scheduleHoverOpen(entry);
            });
            marker.on("mouseout", () => {
                cancelHoverOpen();
                scheduleHoverClose();
            });
            marker.on("click", () => {
                cancelHoverOpen();
                closeHoverPopup();
                openSchoolModal(entry);
            });

            marker.addTo(markersLayer);

            const element = marker.getElement();
            if (element) {
                element.setAttribute("role", "button");
                element.setAttribute("aria-label", markerLabel(entry));
            }
        }

        if (modalEntryKey) {
            const current = entries.find((entry) => entry.key === modalEntryKey);
            if (current) {
                renderModal(current);
            } else {
                closeSchoolModal();
            }
        }
    }

    /* ---------------------------------------------------------------
     * Bulle de survol
     * ------------------------------------------------------------- */

    function levelsForRow(row, cols) {
        return cols.filter((col) => rowHasLevel(row, col));
    }

    // « 12 CP » si l'effectif est connu, « CP » sinon.
    function levelText(row, col) {
        return isNumericNonZero(row[col]) ? `${row[col]} ${col}` : col;
    }

    function buildHoverContent(entry) {
        const singleDomain = activePrimary.size === 1;
        const wrapper = document.createElement("div");
        wrapper.className = singleDomain ? "popup-content popup-content-single-domain" : "popup-content";

        const title = document.createElement("h3");
        title.textContent = entry.name;
        wrapper.appendChild(title);

        const subtitle = document.createElement("p");
        subtitle.className = "popup-year";
        subtitle.textContent = yearLabel(selectedYear);
        wrapper.appendChild(subtitle);

        const rows = matchingRows(entry);
        let shown = 0;

        for (const domain of colsPrimary.filter((col) => activePrimary.has(col))) {
            const projects = rows.filter((row) => isNonEmpty(row[domain]));
            if (projects.length === 0) {
                continue;
            }

            shown += projects.length;

            const heading = document.createElement("h4");
            heading.textContent = domain;
            wrapper.appendChild(heading);

            const list = document.createElement("ul");

            for (const project of projects) {
                const item = document.createElement("li");

                if (singleDomain) {
                    item.className = "project-item";
                    const content = document.createElement("div");
                    content.className = "project-bullet-content";

                    const name = document.createElement("span");
                    name.className = "project-name";
                    name.textContent = String(project[domain]);
                    content.appendChild(name);

                    const levels = levelsForRow(project, colsSecondary);
                    if (levels.length > 0) {
                        const detail = document.createElement("span");
                        detail.className = "project-levels";
                        detail.textContent = `(${levels.map((col) => levelText(project, col)).join(", ")})`;
                        content.appendChild(detail);
                    }

                    item.appendChild(content);
                } else {
                    const levels = levelsForRow(project, [...activeSecondary]);
                    const suffix = levels.length > 0 ? ` (${levels.join(", ")})` : "";
                    item.textContent = `${project[domain]}${suffix}`;
                }

                list.appendChild(item);
            }

            wrapper.appendChild(list);
        }

        if (shown === 0) {
            const empty = document.createElement("p");
            empty.className = "popup-empty";
            empty.textContent = entry.everHasProject
                ? "Aucun projet pour cette sélection."
                : "Aucun projet, toutes années confondues.";
            wrapper.appendChild(empty);
        }

        const more = document.createElement("button");
        more.type = "button";
        more.className = "popup-more";
        more.textContent = "Voir plus";
        more.addEventListener("click", () => {
            closeHoverPopup();
            openSchoolModal(entry);
        });
        wrapper.appendChild(more);

        return wrapper;
    }

    function scheduleHoverOpen(entry) {
        cancelHoverOpen();
        cancelHoverClose();
        hoverOpenTimer = setTimeout(() => {
            hoverOpenTimer = null;
            openHoverPopup(entry);
        }, HOVER_OPEN_DELAY_MS);
    }

    function cancelHoverOpen() {
        if (hoverOpenTimer) {
            clearTimeout(hoverOpenTimer);
            hoverOpenTimer = null;
        }
    }

    function scheduleHoverClose() {
        cancelHoverClose();
        hoverCloseTimer = setTimeout(() => {
            hoverCloseTimer = null;
            closeHoverPopup();
        }, HOVER_CLOSE_DELAY_MS);
    }

    function cancelHoverClose() {
        if (hoverCloseTimer) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }
    }

    function openHoverPopup(entry) {
        if (!map || modalEntryKey || isHelpOpen()) {
            return;
        }

        const popup = L.popup({
            closeButton: false,
            autoPan: false,
            maxWidth: POPUP_MAX_WIDTH,
            className: "hover-popup",
            offset: [0, -6],
        })
            .setLatLng([entry.dLat, entry.dLng])
            .setContent(buildHoverContent(entry));

        hoverPopup = popup;
        popup.openOn(map);

        const element = popup.getElement();
        if (element) {
            element.addEventListener("mouseenter", cancelHoverClose);
            element.addEventListener("mouseleave", scheduleHoverClose);
        }
    }

    function closeHoverPopup() {
        cancelHoverClose();
        if (hoverPopup && map) {
            map.closePopup(hoverPopup);
        }
        hoverPopup = null;
    }

    /* ---------------------------------------------------------------
     * Modale historique : années en colonnes, domaines en lignes
     * ------------------------------------------------------------- */

    function modalDomains() {
        return modalApplyFilters ? colsPrimary.filter((col) => activePrimary.has(col)) : colsPrimary;
    }

    function modalYears() {
        return years.length > 0 ? years : [ALL_YEARS];
    }

    function projectsFor(entry, domain, year) {
        return entry.rows.filter((row) => {
            if (!isNonEmpty(row[domain])) {
                return false;
            }
            if (year !== ALL_YEARS && rowYear(row) !== year) {
                return false;
            }
            return modalApplyFilters ? rowMatchesFilters(row) : true;
        });
    }

    function buildProjectCell(cell, projects, domain) {
        if (projects.length === 0) {
            cell.classList.add("cell-empty");
            cell.textContent = "—";
            return 0;
        }

        const levelCols = modalApplyFilters ? [...activeSecondary] : colsSecondary;

        for (const project of projects) {
            const block = document.createElement("div");
            block.className = "history-project";

            const name = document.createElement("span");
            name.className = "history-project-name";
            name.textContent = String(project[domain] ?? "");
            block.appendChild(name);

            const levels = levelsForRow(project, levelCols);
            if (levels.length > 0) {
                const detail = document.createElement("span");
                detail.className = "history-project-levels";
                detail.textContent = levels.map((col) => levelText(project, col)).join(", ");
                block.appendChild(detail);
            }

            cell.appendChild(block);
        }

        return projects.length;
    }

    function renderModal(entry) {
        const body = document.getElementById("modal-body");
        const title = document.getElementById("modal-title");
        const subtitle = document.getElementById("modal-subtitle");

        title.textContent = entry.name || "École";

        const domains = modalDomains();
        const cols = modalYears();
        const totals = new Map(cols.map((year) => [year, 0]));

        const table = document.createElement("table");
        table.className = "history-table";

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");

        const corner = document.createElement("th");
        corner.className = "col-domain";
        corner.scope = "col";
        corner.textContent = "Domaine";
        headRow.appendChild(corner);

        for (const year of cols) {
            const th = document.createElement("th");
            th.scope = "col";
            th.textContent = year === ALL_YEARS ? "Projets" : year;
            if (year === selectedYear) {
                th.classList.add("is-current");
            }
            headRow.appendChild(th);
        }

        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        let covered = 0;

        for (const domain of domains) {
            const tr = document.createElement("tr");
            let rowTotal = 0;

            const th = document.createElement("th");
            th.className = "col-domain";
            th.scope = "row";
            th.textContent = domain;
            tr.appendChild(th);

            for (const year of cols) {
                const td = document.createElement("td");
                if (year === selectedYear) {
                    td.classList.add("is-current");
                }
                const projects = projectsFor(entry, domain, year);
                const count = buildProjectCell(td, projects, domain);
                rowTotal += count;
                totals.set(year, totals.get(year) + count);
                tr.appendChild(td);
            }

            if (rowTotal === 0) {
                tr.classList.add("row-empty");
            } else {
                covered += 1;
            }

            tbody.appendChild(tr);
        }

        table.appendChild(tbody);

        const tfoot = document.createElement("tfoot");
        const footRow = document.createElement("tr");
        const footLabel = document.createElement("td");
        footLabel.className = "col-domain";
        footLabel.textContent = "Total";
        footRow.appendChild(footLabel);

        for (const year of cols) {
            const td = document.createElement("td");
            if (year === selectedYear) {
                td.classList.add("is-current");
            }
            td.textContent = String(totals.get(year));
            footRow.appendChild(td);
        }

        tfoot.appendChild(footRow);
        table.appendChild(tfoot);

        body.textContent = "";
        body.appendChild(table);

        subtitle.textContent = `${covered} domaine${covered > 1 ? "s" : ""} sur ${domains.length} abordé${covered > 1 ? "s" : ""}`;

        const note = document.createElement("p");
        note.className = "modal-note";
        note.textContent = "Les lignes grisées correspondent aux domaines jamais abordés par cette école.";
        body.appendChild(note);
    }

    function openSchoolModal(entry) {
        const overlay = document.getElementById("school-modal");
        modalEntryKey = entry.key;
        renderModal(entry);
        overlay.classList.remove("hidden");
        lastFocusedBeforeModal = document.activeElement;
        document.getElementById("modal-close").focus();
        document.addEventListener("keydown", onModalKeydown, true);
    }

    function closeSchoolModal() {
        if (!modalEntryKey) {
            return;
        }
        modalEntryKey = null;
        document.getElementById("school-modal").classList.add("hidden");
        document.removeEventListener("keydown", onModalKeydown, true);
        if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === "function") {
            lastFocusedBeforeModal.focus();
        }
        lastFocusedBeforeModal = null;
    }

    function onModalKeydown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            closeSchoolModal();
            return;
        }
        trapFocus(event, document.querySelector("#school-modal .modal"));
    }

    // Garde Tab et Maj+Tab à l'intérieur d'une fenêtre modale.
    function trapFocus(event, modal) {
        if (event.key !== "Tab" || !modal) {
            return;
        }

        const focusable = [...modal.querySelectorAll("button, input, select, [href], [tabindex]:not([tabindex='-1'])")]
            .filter((el) => !el.disabled && el.offsetParent !== null);

        if (focusable.length === 0) {
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    /* ---------------------------------------------------------------
     * Modale d'aide
     * ------------------------------------------------------------- */

    function isHelpOpen() {
        return !document.getElementById("help-modal").classList.contains("hidden");
    }

    function openHelp() {
        if (isHelpOpen()) {
            return;
        }
        cancelHoverOpen();
        closeHoverPopup();
        lastFocusedBeforeHelp = document.activeElement;
        document.getElementById("help-modal").classList.remove("hidden");
        document.getElementById("help-btn").setAttribute("aria-expanded", "true");
        document.getElementById("help-close").focus();
        document.addEventListener("keydown", onHelpKeydown, true);
    }

    function closeHelp() {
        if (!isHelpOpen()) {
            return;
        }
        document.getElementById("help-modal").classList.add("hidden");
        document.getElementById("help-btn").setAttribute("aria-expanded", "false");
        document.removeEventListener("keydown", onHelpKeydown, true);
        if (lastFocusedBeforeHelp && typeof lastFocusedBeforeHelp.focus === "function") {
            lastFocusedBeforeHelp.focus();
        }
        lastFocusedBeforeHelp = null;
    }

    function onHelpKeydown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            closeHelp();
            return;
        }
        trapFocus(event, document.querySelector("#help-modal .modal"));
    }

    function bindHelp() {
        const overlay = document.getElementById("help-modal");
        document.getElementById("help-btn").addEventListener("click", openHelp);
        document.getElementById("help-close").addEventListener("click", closeHelp);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeHelp();
            }
        });
    }

    /* ---------------------------------------------------------------
     * Listes de filtres
     * ------------------------------------------------------------- */

    function buildFilterList(containerId, cols, activeSet, onChange) {
        const container = document.getElementById(containerId);
        container.textContent = "";

        activeSet.clear();
        for (const col of cols) {
            activeSet.add(col);
        }

        const allId = `${containerId}-all`;
        const allItem = document.createElement("div");
        allItem.className = "filter-item select-all";
        const allCb = document.createElement("input");
        allCb.type = "checkbox";
        allCb.id = allId;
        allCb.checked = true;
        const allLabel = document.createElement("label");
        allLabel.htmlFor = allId;
        allLabel.textContent = "Tout sélectionner";
        allItem.append(allCb, allLabel);
        container.appendChild(allItem);

        const itemCheckboxes = [];

        for (let index = 0; index < cols.length; index += 1) {
            const col = cols[index];
            const id = `${containerId}-${index}`;
            const item = document.createElement("div");
            item.className = "filter-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.id = id;
            cb.checked = true;
            cb.dataset.col = col;
            const label = document.createElement("label");
            label.htmlFor = id;
            label.textContent = col;
            item.append(cb, label);
            container.appendChild(item);
            itemCheckboxes.push(cb);

            cb.addEventListener("change", () => {
                if (cb.checked) {
                    activeSet.add(col);
                } else {
                    activeSet.delete(col);
                }
                allCb.checked = itemCheckboxes.every((c) => c.checked);
                onChange();
            });
        }

        allCb.addEventListener("change", () => {
            for (const cb of itemCheckboxes) {
                cb.checked = allCb.checked;
                if (allCb.checked) {
                    activeSet.add(cb.dataset.col);
                } else {
                    activeSet.delete(cb.dataset.col);
                }
            }
            onChange();
        });
    }

    function buildFilters() {
        buildFilterList("filter-primary", colsPrimary, activePrimary, renderMap);
        buildFilterList("filter-secondary", colsSecondary, activeSecondary, renderMap);
    }

    /* ---------------------------------------------------------------
     * Mappage des colonnes
     * ------------------------------------------------------------- */

    function isReady() {
        return Boolean(colName && colLat && colLng && colsPrimary.length > 0 && colsSecondary.length > 0);
    }

    function rebuild() {
        if (!isReady()) {
            return;
        }
        collectYears();
        buildYearSelect();
        buildEntries();
        renderMap();
    }

    function applyMappings(mappings) {
        const nextColName = typeof mappings?.Name === "string" ? mappings.Name : null;
        const nextColLat = typeof mappings?.Latitude === "string" ? mappings.Latitude : null;
        const nextColLng = typeof mappings?.Longitude === "string" ? mappings.Longitude : null;
        const nextColSchool = typeof mappings?.School === "string" ? mappings.School : null;
        const nextColYear = typeof mappings?.Year === "string" ? mappings.Year : null;
        const nextColsPrimary = toArray(mappings?.Primary);
        const nextColsSecondary = toArray(mappings?.Secondary);

        const filtersChanged =
            !arraysEqual(colsPrimary, nextColsPrimary) || !arraysEqual(colsSecondary, nextColsSecondary);

        colName = nextColName;
        colLat = nextColLat;
        colLng = nextColLng;
        colSchool = nextColSchool;
        colYear = nextColYear;
        colsPrimary = nextColsPrimary;
        colsSecondary = nextColsSecondary;

        if (!isReady()) {
            if (markersLayer) {
                markersLayer.clearLayers();
            }
            entries = [];
            closeSchoolModal();
            scheduleNoConfigMessage(DEFAULT_NO_CONFIG_MESSAGE);
            return;
        }

        hideNoConfigMessage();
        if (filtersChanged) {
            buildFilters();
        }
        rebuild();
    }

    /* ---------------------------------------------------------------
     * Initialisation
     * ------------------------------------------------------------- */

    function bindHiddenToggles() {
        const toggleBtn = document.getElementById("toggle-hidden");
        const hiddenOnlyBtn = document.getElementById("toggle-hidden-only");

        if (!toggleBtn) {
            return;
        }

        const updateToggleUi = () => {
            toggleBtn.setAttribute("aria-pressed", String(showHidden));
            document.getElementById("icon-eye-open").style.display = showHidden ? "" : "none";
            document.getElementById("icon-eye-closed").style.display = showHidden ? "none" : "";

            if (hiddenOnlyBtn) {
                hiddenOnlyBtn.classList.toggle("hidden", !showHidden);
                hiddenOnlyBtn.setAttribute("aria-pressed", String(showHiddenOnly));
                // L'infobulle annonce l'effet du prochain clic.
                hiddenOnlyBtn.title = showHiddenOnly ? HIDDEN_ONLY_TITLE_OFF : HIDDEN_ONLY_TITLE_ON;
            }
        };

        updateToggleUi();

        toggleBtn.addEventListener("click", () => {
            showHidden = !showHidden;
            if (!showHidden) {
                showHiddenOnly = false;
            }
            updateToggleUi();
            renderMap();
        });

        if (hiddenOnlyBtn) {
            hiddenOnlyBtn.addEventListener("click", () => {
                if (!showHidden) {
                    return;
                }
                showHiddenOnly = !showHiddenOnly;
                updateToggleUi();
                renderMap();
            });
        }
    }

    function bindModal() {
        const overlay = document.getElementById("school-modal");
        const applyFilters = document.getElementById("modal-apply-filters");

        document.getElementById("modal-close").addEventListener("click", closeSchoolModal);

        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeSchoolModal();
            }
        });

        applyFilters.addEventListener("change", () => {
            modalApplyFilters = applyFilters.checked;
            const entry = entries.find((item) => item.key === modalEntryKey);
            if (entry) {
                renderModal(entry);
            }
        });
    }

    function bindYearSelect() {
        document.getElementById("year-select").addEventListener("change", (event) => {
            selectedYear = event.target.value;
            // Les écoles affichées dépendent de l'année : ouvertures et fermetures.
            buildEntries();
            renderMap();
        });
    }

    function init() {
        if (typeof grist === "undefined") {
            document.getElementById("no-config").querySelector("span").textContent =
                "Widget non chargé dans Grist.";
            return;
        }
        if (!window.GristColumns || !window.SchoolYears) {
            showNoConfigMessage("Les modules partagés du dossier shared ne se sont pas chargés.");
            return;
        }

        document.addEventListener(
            "pointerdown",
            (event) => {
                pointerIsCoarse = event.pointerType !== "mouse";
            },
            true
        );

        bindHiddenToggles();
        bindModal();
        bindHelp();
        bindYearSelect();
        ensureMap();

        window.addEventListener("resize", refreshMapSize);

        grist.ready({
            requiredAccess: "full",
            columns: [
                { name: "Name", title: "Nom", type: "Text" },
                { name: "Latitude", title: "Latitude", type: "Numeric" },
                { name: "Longitude", title: "Longitude", type: "Numeric" },
                { name: "Primary", title: "Domaines", type: "Text", allowMultiple: true },
                { name: "Secondary", title: "Niveaux", type: "Int", allowMultiple: true },
                // Types volontairement permissifs : ces deux colonnes sont lues
                // de façon défensive et un mauvais mappage retombe sur les coordonnées.
                { name: "Year", title: "Année scolaire", type: "Any", optional: true },
                { name: "School", title: "École (colonne UAI)", type: "Any", optional: true },
            ],
        });

        // expandRefs: false : par défaut, Grist transmet la valeur affichée
        // d'une colonne Référence (code UAI, nom…) au lieu de l'identifiant de
        // ligne. Les projets ne seraient alors pas rattachés à leur école du
        // référentiel, qui apparaîtrait en double, sans projet.
        grist.onRecords((records, mappings) => {
            const mapReady = ensureMap();
            allRows = Array.isArray(records) ? records : [];
            schoolsRefreshQueued = false;
            void ensureSchools();
            applyMappings(mappings ?? null);
            // Les drapeaux changent avec les lignes : relus à chaque envoi.
            loadLevelFlags().then(rebuild);
            if (mapReady) {
                setTimeout(refreshMapSize, 0);
            }
        }, { expandRefs: false });
    }

    document.addEventListener("DOMContentLoaded", init);
})();
