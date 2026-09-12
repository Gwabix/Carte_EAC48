'use strict';

/*
 * Module partagé — lecture de la définition des colonnes Grist.
 *
 * Les widgets ont besoin du type, du libellé et des widgetOptions (donc des
 * listes de choix) de certaines colonnes. Deux voies, essayées dans cet ordre :
 *
 *  1. TABLES SYSTÈME, via l'API du plugin. `_grist_Tables` donne le row ID de
 *     la table, `_grist_Tables_column` la définition de ses colonnes. Aucun
 *     appel réseau sortant, aucun jeton : l'accès « full » du widget suffit.
 *
 *  2. API REST, via un jeton d'accès en lecture seule. Repli seulement. Le
 *     point d'entrée /columns lit des métadonnées de structure et non des
 *     données de table, or les jetons d'accès ne le couvrent pas partout :
 *     l'instance répond alors 404, sans message exploitable.
 *
 * Les valeurs ne sont jamais « trimmées » : une liste de choix relue puis
 * réécrite doit correspondre au caractère près à celle définie dans Grist.
 * Les caractères de contrôle sont retirés et la longueur bornée.
 *
 * Retourne null si aucune voie n'aboutit — à l'appelant de prévoir un défaut.
 */

(function (global) {
    const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
    const MAX_TEXT_LENGTH = 500;

    function cleanText(value) {
        if (typeof value !== 'string') return '';
        return value.slice(0, MAX_TEXT_LENGTH).replace(CONTROL_CHARS, '');
    }

    function parseWidgetOptions(raw) {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
        if (typeof raw !== 'string' || !raw.trim()) return {};
        try {
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (err) {
            return {};
        }
    }

    // Choix d'une colonne Choice / ChoiceList, dédoublonnés, dans l'ordre Grist.
    function extractChoices(opts) {
        if (!opts || !Array.isArray(opts.choices)) return [];
        const seen = new Set();
        const choices = [];
        for (const raw of opts.choices) {
            if (typeof raw !== 'string') continue;
            const label = cleanText(raw);
            if (!label || seen.has(label)) continue;
            seen.add(label);
            choices.push(label);
        }
        return choices;
    }

    function buildDef(colId, fields) {
        const opts = parseWidgetOptions(fields.widgetOptions);
        return {
            choices: extractChoices(opts),
            type: cleanText(fields.type),
            label: cleanText(fields.label) || colId,
            widgetOptions: opts
        };
    }

    // Colonne d'une table système, tolérante à la casse du nom. Retourne un
    // tableau vide plutôt qu'undefined : un accès indexé ne doit pas lever.
    function metaColumn(table, names) {
        for (const name of names) {
            const values = table ? table[name] : null;
            if (Array.isArray(values)) return values;
        }
        return [];
    }

    // Voie 1 — tables système.
    async function fromMetaTables(tableId, wanted) {
        const tables = await grist.docApi.fetchTable('_grist_Tables');
        const index = metaColumn(tables, ['tableId', 'TableId']).indexOf(tableId);
        if (index === -1) {
            throw new Error('Table « ' + tableId + ' » absente de _grist_Tables.');
        }
        const tableRowId = Number(tables.id[index]);

        const cols = await grist.docApi.fetchTable('_grist_Tables_column');
        const colIdValues = metaColumn(cols, ['colId', 'ColId']);
        if (!colIdValues.length) {
            throw new Error('_grist_Tables_column illisible.');
        }

        const parentIds = metaColumn(cols, ['parentId', 'ParentId']);
        const types = metaColumn(cols, ['type', 'Type']);
        const labels = metaColumn(cols, ['label', 'Label']);
        const widgetOptions = metaColumn(cols, ['widgetOptions', 'WidgetOptions']);

        const result = {};
        for (let i = 0; i < colIdValues.length; i++) {
            if (Number(parentIds[i]) !== tableRowId) continue;
            const colId = colIdValues[i];
            if (!wanted.has(colId)) continue;
            result[colId] = buildDef(colId, {
                type: types[i],
                label: labels[i],
                widgetOptions: widgetOptions[i]
            });
        }
        return result;
    }

    // Voie 2 — API REST.
    async function fromRestApi(tableId, wanted) {
        const tokenInfo = await grist.docApi.getAccessToken({ readOnly: true });
        const url = tokenInfo.baseUrl + '/tables/' + encodeURIComponent(tableId) + '/columns'
            + '?auth=' + encodeURIComponent(tokenInfo.token);

        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) throw new Error('Statut HTTP ' + response.status);

        const data = await response.json();
        const columns = Array.isArray(data && data.columns) ? data.columns : [];

        const result = {};
        for (const column of columns) {
            if (!column || !wanted.has(column.id) || !column.fields) continue;
            result[column.id] = buildDef(column.id, column.fields);
        }
        return result;
    }

    /**
     * Définition des colonnes demandées.
     * @param {string} tableId identifiant de table Grist
     * @param {string[]} colIds identifiants de colonnes
     * @returns {Promise<Object|null>} { [colId]: { choices, type, label, widgetOptions } }
     *          Une colonne absente du document n'a pas de clé. null si la
     *          définition n'a pu être lue par aucune voie.
     */
    async function fetchColumnDefs(tableId, colIds) {
        const wanted = new Set(Array.isArray(colIds) ? colIds.filter(Boolean) : []);
        if (!tableId || !wanted.size) return {};

        try {
            return await fromMetaTables(tableId, wanted);
        } catch (metaErr) {
            console.info('[Colonnes] Tables système illisibles, repli sur l\'API REST :',
                (metaErr && metaErr.message) ? metaErr.message : metaErr);
        }

        try {
            return await fromRestApi(tableId, wanted);
        } catch (restErr) {
            console.info('[Colonnes] Définition des colonnes indisponible :',
                (restErr && restErr.message) ? restErr.message : restErr);
            return null;
        }
    }

    /**
     * Identifiants des colonnes de DONNÉES d'une table, formules exclues.
     *
     * Sert à n'écrire que dans des colonnes inscriptibles. `isFormula`
     * distingue une colonne calculée d'une colonne de données : une colonne
     * de données à formule d'initialisation a `isFormula` faux et reste donc
     * inscriptible, ce qui est bien le comportement voulu.
     *
     * Les colonnes internes de Grist sont écartées : `manualSort`, qui porte
     * l'ordre des lignes, et les colonnes d'affichage `gristHelper_*` des
     * références.
     *
     * @param {string} tableId
     * @returns {Promise<string[]|null>} null si la liste n'a pu être lue.
     */
    async function fetchDataColumnIds(tableId) {
        try {
            const tables = await grist.docApi.fetchTable('_grist_Tables');
            const index = metaColumn(tables, ['tableId', 'TableId']).indexOf(tableId);
            if (index === -1) {
                throw new Error('Table « ' + tableId + ' » absente de _grist_Tables.');
            }
            const tableRowId = Number(tables.id[index]);

            const cols = await grist.docApi.fetchTable('_grist_Tables_column');
            const colIds = metaColumn(cols, ['colId', 'ColId']);
            const parentIds = metaColumn(cols, ['parentId', 'ParentId']);
            const isFormula = metaColumn(cols, ['isFormula', 'IsFormula']);

            const result = [];
            for (let i = 0; i < colIds.length; i++) {
                if (Number(parentIds[i]) !== tableRowId) continue;
                if (isFormula[i]) continue;

                const colId = colIds[i];
                if (typeof colId !== 'string' || !colId) continue;
                if (colId === 'manualSort' || colId.indexOf('gristHelper_') === 0) continue;

                result.push(colId);
            }
            return result;
        } catch (err) {
            console.info('[Colonnes] Colonnes de données indisponibles : '
                + ((err && err.message) ? err.message : err));
            return null;
        }
    }

    global.GristColumns = { fetchColumnDefs, fetchDataColumnIds };

})(typeof window !== 'undefined' ? window : this);
