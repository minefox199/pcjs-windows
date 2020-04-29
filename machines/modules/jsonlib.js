/**
 * @fileoverview JSON library
 * @author Jeff Parsons <Jeff@pcjs.org>
 * @copyright © 2012-2020 Jeff Parsons
 * @license MIT <https://www.pcjs.org/LICENSE.txt>
 *
 * This file is part of PCjs, a computer emulation software project at <https://www.pcjs.org>.
 */

/**
 * @class {JSONLib}
 */
export default class JSONLib {
    /**
     * parseDiskettes(aDiskettes, library, propPath, server, hostName, limits)
     *
     * @param {Array} aDiskettes
     * @param {Object} library
     * @param {string} [propPath]
     * @param {string} [server]
     * @param {string} [hostName]
     * @param {Array} [limits] (optional drive limits from FDC.getDriveLimits())
     */
    static parseDiskettes(aDiskettes, library, propPath = "/pcx86", server = "", hostName = "", limits = [])
    {
        for (let category in library) {
            if (category[0] == '@') {
                if (category == '@server') server = library[category];
                continue;
            }
            let group = library[category];
            let products = group['@products'];
            if (products) {
                JSONLib.parseDiskettes(aDiskettes, products, propPath + '/' + category, server, hostName, limits);
                continue;
            }
            let versions = group['@versions'];
            if (versions) {
                for (let version in versions) {
                    let release = versions[version];
                    let media = release['@media'];
                    if (!media) continue;
                    for (let i = 0; i < media.length; i++) {
                        let item = media[i];
                        if (!item['@diskette']) continue;
                        /*
                         * One advantage of the new JSON library manifest is that it gives us more information about the
                         * available diskettes before loading any of them.  For example, if the drives support only one head,
                         * we can avoid including any diskette whose '@type' is "PC320K", "PC360K", etc; and if the drives
                         * don't support 80 tracks, we can skip any "PC1200K" and "PC1440K" diskettes.
                         *
                         * Unfortunately, either of those drive criteria must be true for ALL installed drives, due to the way
                         * our UI works, which displays only one list of diskettes for all drives.  But that's reasonable,
                         * since most (if not all) of our machines have matching diskette drives.
                         *
                         * NOTE: It's best not to check for specific '@type' values, because there were many unusual diskette
                         * formats.
                         *
                         * Standard PC types included:
                         *
                         *      PC160K
                         *      PC180K
                         *      PC320K
                         *      PC360K
                         *      PC720K
                         *      PC1200K
                         *      PC1440K
                         *
                         * Non-standard PC types included:
                         *
                         *      PC1840K (eg, XDF diskettes that shipped with PC DOS 7.0)
                         *      PC1680K (eg, DMF diskettes that shipped with Windows 95)
                         *
                         * and this list should certainly NOT be considered exhaustive.  Non-PC types would include things like
                         * game disks with unusual track formats, assorted UNIX distribution diskettes, etc; for those disks,
                         * we haven't come up with a type nomenclature yet, so no '@type' will be specified.  Any disk of unknown
                         * type should always be included.
                         */
                        let type = item['@type'];
                        if (type && limits.length) {
                            let match = type.match(/^PC([0-9]+)K$/);
                            if (match) {
                                let size = +match[1];
                                if (limits[0] == 1 && size > 180 || limits[1] == 40 && size > 360) {
                                    continue;
                                }
                            }
                        }
                        let name = item['@title'];
                        if (!name) {
                            name = release['@title'];
                            if (!name) {
                                name = group['@title'];
                                if (version) name += ' ' + version;
                            }
                            if (media.length > 1) {
                                name += " (Disk " + (i + 1) + ")";
                            }
                        }
                        let path = item['@link'] || (server + propPath + '/' + category + '/' + (version? version + '/' : '') + item['@diskette']);
                        if (!item['@localonly'] || hostName == "localhost") {
                            aDiskettes.push({name, path});
                        }
                    }
                }
                continue;
            }
            if (category[0] == '@') continue;
            JSONLib.parseDiskettes(aDiskettes, group, propPath + '/' + category, group['@server'] || server, hostName, limits);
        }
    }
}