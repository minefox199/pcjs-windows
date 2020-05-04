/**
 * @fileoverview Disk image processing module
 * @author Jeff Parsons <Jeff@pcjs.org>
 * @copyright © 2012-2020 Jeff Parsons
 * @license MIT <https://www.pcjs.org/LICENSE.txt>
 *
 * This file is part of PCjs, a computer emulation software project at <https://www.pcjs.org>.
 */

import CPUx86 from "./cpux86.js";
import Device from "../../modules/device.js";
import FileInfo from "./fileinfo.js";

/**
 * VolInfo describes a volume.  NOTE: this list of properties may not be
 * exhaustive (it may omit certain internal calculations), but at the very least,
 * it should include every "volume descriptor" property we export via getVolDesc().
 *
 * @typedef {Object} VolInfo
 * @property {number} iVolume
 * @property {number} iPartition
 * @property {number} idMedia
 * @property {number} lbaStart
 * @property {number} lbaTotal
 * @property {number} nFATBits
 * @property {number} vbaFAT
 * @property {number} vbaRoot
 * @property {number} nEntries
 * @property {number} vbaData
 * @property {number} clusSecs
 * @property {number} clusMax
 * @property {number} clusBad
 * @property {number} clusFree
 * @property {number} clusTotal
 */

/**
 * FileData is an input data structure that callers of buildDiskFromFiles() must provide.
 *
 * @typedef {Object} FileData
 * @property {string} path
 * @property {string} name
 * @property {number} attr
 * @property {Date} date
 * @property {number} size
 * @property {DataBuffer} data
 * @property {number} cluster
 * @property {Array.<FileData>} files
 */

/**
 * Sector describes a sector contained within a disk image.  Storing the cylinder and head
 * of a sector within the structure is a bit redundant, but I find it helpful for inspection
 * and verification purposes.
 *
 * @typedef {Object} Sector
 * @property {number} c (cylinder #)
 * @property {number} h (head #)
 * @property {number} s (sector ID)
 * @property {number} l (length of sector, in bytes)
 * @property {Array.<number>} d (array of 32-bit values)
 * @property {number} f (index into the disk's file table)
 * @property {number} o (offset of this sector within the file's data stream)
 * @property {number} dataCRC
 * @property {boolean} dataError
 * @property {number} dataMark
 * @property {number} headCRC
 * @property {boolean} headError
 * @property {number} iModify (used only with fWritable disk images)
 * @property {number} cModify (used only with fWritable disk images)
 */

/**
 * @class DiskImage
 * @property {string} diskName
 * @property {boolean} fWritable
 * @property {Array} aDiskData
 * @property {number} cbDiskData
 * @property {number} dwChecksum
 * @property {number} nCylinders
 * @property {number} nHeads
 * @property {number} nSectors
 * @property {number} cbSector
 * @property {Array.<VolInfo>|null} volTable
 * @property {Array.<FileInfo>|null} fileTable
 */
export default class DiskImage {
    /**
     * DiskImage(device, diskName, fWritable)
     *
     * Returns a DiskImage object used to build a disk images.
     *
     * @this {DiskImage}
     * @param {Device} device
     * @param {string} [diskName]
     * @param {boolean} [fWritable]
     */
    constructor(device, diskName = "", fWritable = false)
    {
        this.device = device;
        this.printf = device.printf.bind(device);
        this.assert = device.assert.bind(device);
        this.diskName = diskName;
        this.hash = "none";
        this.args = "";
        this.fWritable = fWritable;
        this.volTable = [];
        this.fileTable = [];
    }

    /**
     * buildDiskFromBuffer(dbDisk, hash, forceBPB, sectorIDs, sectorErrors, suppData)
     *
     * Build a disk image from a DataBuffer.
     *
     * All callers are now required to convert their data to a DataBuffer first.  For example, if the caller
     * received an ArrayBuffer from a FileReader object, they must first create a DataBuffer from the ArrayBuffer.
     *
     * Here's the initial (simplified) version of this function.  It got much more complicated over time
     * as more diskettes were processed and anomalies were discovered.
     *
     *      let diskFormat = DiskImage.GEOMETRIES[db.length];
     *      if (diskFormat) {
     *          let ib = 0;
     *          this.cbDiskData = db.length;
     *          this.nCylinders = diskFormat[0];
     *          this.nHeads = diskFormat[1];
     *          this.nSectors = diskFormat[2];
     *          this.cbSector = (diskFormat[3] || 512);
     *          this.aDiskData = new Array(this.nCylinders);
     *          for (let iCylinder = 0; iCylinder < this.aDiskData.length; iCylinder++) {
     *              let cylinder = this.aDiskData[iCylinder] = new Array(this.nHeads);
     *              for (let iHead = 0; iHead < cylinder.length; iHead++) {
     *                  let head = cylinder[iHead] = new Array(this.nSectors);
     *                  for (let iSector = 0; iSector < head.length; iSector++) {
     *                      head[iSector] = this.buildSector(iCylinder, iHead, iSector + 1, this.cbSector, db, ib);
     *                      ib += this.cbSector;
     *                  }
     *              }
     *          }
     *          return true;
     *      }
     *
     * @this {DiskImage}
     * @param {DataBuffer} dbDisk
     * @param {string} [hash]
     * @param {fForceBPP} [forceBPB]
     * @param {Array|string} [sectorIDs]
     * @param {Array|string} [sectorErrors]
     * @param {string} [suppData] (eg, supplementary disk data that can be found in such files as: /software/pcx86/app/microsoft/word/1.15/debugger/index.md)
     * @returns {boolean} true if successful (aDiskData initialized); false otherwise
     */
    buildDiskFromBuffer(dbDisk, hash, forceBPB, sectorIDs, sectorErrors, suppData)
    {
        this.aDiskData = null;
        this.cbDiskData = 0;
        this.dwChecksum = 0;
        this.fromJSON = false;

        let nHeads = 0;
        let nCylinders = 0;
        let nSectorsPerTrack = 0;
        let aTracks = [];                   // track array (used only for disk images with track tables)
        let cbSector = 512;                 // default sector size
        let bMediaID = 0;
        let offBootSector = 0;
        let cbDiskData = dbDisk.length, cbPartition = cbDiskData;

        let dbTrack, dbSector;
        let iTrack, cbTrack, offTrack, offSector;

        if (cbDiskData >= 3000000) {        // arbitrary threshold between diskette image sizes and hard drive image sizes
            let wSig = dbDisk.readUInt16LE(DiskImage.BOOT.SIG_OFFSET);
            if (wSig == DiskImage.BOOT.SIGNATURE) {
                /*
                 * In this case, the first sector should be an MBR; find the active partition entry,
                 * then read the LBA of the first partition sector to calculate the boot sector offset.
                 */
                for (let offEntry = 0x1BE; offEntry <= 0x1EE; offEntry += 0x10) {
                    if (dbDisk.readUInt8(offEntry) >= 0x80) {
                        offBootSector = dbDisk.readUInt32LE(offEntry + 0x08) * cbSector;
                        cbPartition = dbDisk.readUInt32LE(offEntry + 0x0C) * cbSector;
                        break;
                    }
                }
            }
            /*
             * If we failed to find an active entry, we'll fall into the BPB detection code, which
             * should fail if the first sector really was an MBR.  Otherwise, the BPB should give us
             * the geometry info we need to dump the entire disk image, including the MBR and any
             * other reserved sectors.
             */
        }

        let bByte0 = dbDisk.readUInt8(offBootSector + DiskImage.BPB.JMP_OPCODE);
        let bByte1 = dbDisk.readUInt8(offBootSector + DiskImage.BPB.JMP_OPCODE + 1);
        let cbSectorBPB = dbDisk.readUInt16LE(offBootSector + DiskImage.BPB.SECTOR_BYTES);

        /*
         * Save the original BPB, in case we need to modify it later.
         */
        this.abOrigBPB = [];
        this.fBPBModified = false;
        this.abOrigBPB.push(offBootSector);
        for (let i = DiskImage.BPB.JMP_OPCODE; i < DiskImage.BPB.LARGE_SECS+4; i++) {
            this.abOrigBPB.push(dbDisk.readUInt8(offBootSector + i));
        }

        /*
         * These checks are not only necessary for DOS 1.x diskette images (and other pre-BPB images),
         * but also non-DOS diskette images (eg, CPM-86 diskettes).
         *
         * And we must perform these tests BEFORE checking for a BPB, because we want the PHYSICAL geometry
         * of the disk, whereas any values in the BPB may only be LOGICAL. For example, DOS may only be using
         * 8 sectors per track on diskette that's actually formatted with 9 sectors per track.
         *
         * Checking these common sizes insures we get the proper physical geometry for common disk formats,
         * but at some point, we'll need to perform more general calculations to properly deal with ANY disk
         * image whose logical format doesn't agree with its physical structure.
         */
        let fXDFOutput = false;
        let diskFormat = DiskImage.GEOMETRIES[cbDiskData];
        if (diskFormat) {
            nCylinders = diskFormat[0];
            nHeads = diskFormat[1];
            nSectorsPerTrack = diskFormat[2];
            cbSector = diskFormat[3] || cbSector;
            bMediaID = diskFormat[4] || bMediaID;
        }

        /*
         * I used to do these BPB tests only if diskFormat was undefined, but now I always do them, because I
         * want to make sure they're in agreement (and if not, then figure out why not).
         *
         * See if the first sector of the image contains a valid DOS BPB.  That begs the question: what IS a valid
         * DOS BPB?  For starters, the first word (at offset 0x0B) is invariably 0x0200, indicating a 512-byte sector
         * size.  I also check the first byte for an Intel JMP opcode (0xEB is JMP with a 1-byte displacement, and
         * 0xE9 is JMP with a 2-byte displacement).  What else?
         */
        let fBPBExists = false, bMediaIDBPB = 0;

        if ((bByte0 == CPUx86.OPCODE.JMP || bByte0 == CPUx86.OPCODE.JMPS) && cbSectorBPB == cbSector) {

            let nHeadsBPB = dbDisk.readUInt16LE(offBootSector + DiskImage.BPB.TOTAL_HEADS);
            let nSectorsPerTrackBPB = dbDisk.readUInt16LE(offBootSector + DiskImage.BPB.TRACK_SECS);

            if (nHeadsBPB && nSectorsPerTrackBPB) {

                fBPBExists = true;
                bMediaIDBPB = dbDisk.readUInt8(offBootSector + DiskImage.BPB.MEDIA_ID);

                let nSectorsTotalBPB = dbDisk.readUInt16LE(offBootSector + DiskImage.BPB.TOTAL_SECS);
                let nSectorsPerCylinderBPB = nSectorsPerTrackBPB * nHeadsBPB;
                let nSectorsHiddenBPB = dbDisk.readUInt16LE(offBootSector + DiskImage.BPB.HIDDEN_SECS);
                let nCylindersBPB = (nSectorsHiddenBPB + nSectorsTotalBPB) / nSectorsPerCylinderBPB;

                if (diskFormat) {
                    if (bMediaID && bMediaID != bMediaIDBPB) {
                        this.printf(Device.MESSAGE.WARN, "BPB media ID (%#0bx) does not match physical media ID (%#0bx)\n", bMediaIDBPB, bMediaID);
                    }
                    if (nCylinders != nCylindersBPB) {
                        this.printf(Device.MESSAGE.WARN, "BPB cylinders (%d) do not match physical cylinders (%d)\n", nCylindersBPB, nCylinders);
                        if (nCylinders - nCylindersBPB == 1) {
                            this.printf(Device.MESSAGE.WARN, "BIOS may have reserved the last cylinder for diagnostics\n");
                        }
                    }
                    if (nHeads != nHeadsBPB) {
                        this.printf(Device.MESSAGE.WARN, "BPB heads (%d) do not match physical heads (%d)\n", nHeadsBPB, nHeads);
                    }
                    if (nSectorsPerTrack != nSectorsPerTrackBPB) {
                        this.printf(Device.MESSAGE.WARN, "BPB sectors/track (%d) do not match physical sectors/track (%d)\n", nSectorsPerTrackBPB, nSectorsPerTrack);
                    }
                }
                else {
                    nHeads = nHeadsBPB;
                    nSectorsPerTrack = nSectorsPerTrackBPB;
                    nCylinders = cbDiskData / (nHeads * nSectorsPerTrack * cbSector);
                    if (nCylinders != (nCylinders|0)) {
                        this.printf(Device.MESSAGE.WARN, "total cylinders (%d) not a multiple of heads (%d) and sectors/track (%d)\n", nCylinders, nHeads, nSectorsPerTrack);
                        nCylinders |= 0;
                    }
                    bMediaID = bMediaIDBPB;
                }

                /*
                 * OK, great, the disk appears to contain a valid BPB.  But so do XDF disk images, which are
                 * diskette images with tracks containing:
                 *
                 *      1 8Kb sector (equivalent of 16 512-byte sectors)
                 *      1 2Kb sector (equivalent of 4 512-byte sectors)
                 *      1 1Kb sector (equivalent of 2 512-byte sectors)
                 *      1 512-byte sector (equivalent of, um, 1 512-byte sector)
                 *
                 * for a total of the equivalent of 23 512-byte sectors, or 11776 (0x2E00) bytes per track.
                 * For an 80-track diskette with 2 sides, that works out to a total of 3680 512-byte sectors,
                 * or 1884160 bytes, or 1.84Mb, which is the exact size of the (only) XDF diskette images we
                 * currently (try to) support.
                 *
                 * Moreover, the first two tracks (ie, the first cylinder) contain only 19 sectors each,
                 * rather than 23, but XDF disk images still pads those tracks with 4 unused sectors.
                 *
                 * So, data for the first track contains 1 boot sector ending at 512 (0x200), 11 FAT sectors
                 * ending at 6144 (0x1800), and 7 "micro-disk" sectors ending at 9728 (0x2600).  Then there's
                 * 4 (useless?) sectors that end at 11776 (0x2E00).
                 *
                 * Data for the second track contains 7 root directory sectors ending at 15360 (0x3C00), followed
                 * by disk data.
                 *
                 * For more details, check out this helpful article: http://www.os2museum.com/wp/the-xdf-diskette-format/
                 */
                if (nSectorsTotalBPB == 3680 && this.fXDFSupport) {
                    this.printf(Device.MESSAGE.WARN, "XDF diskette detected, experimental XDF output enabled\n");
                    fXDFOutput = true;
                }
            }
        }

        /*
         * Let's see if we can find a corresponding BPB in our table of default BPBs.
         */
        let iBPB = -1;
        if (bMediaID) {
            for (let i = 0; i < DiskImage.aDefaultBPBs.length; i++) {
                if (DiskImage.aDefaultBPBs[i][DiskImage.BPB.MEDIA_ID] == bMediaID) {
                    let cbDiskBPB = (DiskImage.aDefaultBPBs[i][DiskImage.BPB.TOTAL_SECS] + (DiskImage.aDefaultBPBs[i][DiskImage.BPB.TOTAL_SECS + 1] * 0x100)) * cbSector;
                    if (cbDiskBPB == cbDiskData) {
                        /*
                         * This code was added to deal with variations in sectors/cluster.  Most software manufacturers
                         * were happy with the defaults that FORMAT chooses for a given diskette size, but in a few cases
                         * (eg, PC DOS 4.00 360K diskettes, PC DOS 4.01 720K diskettes, etc), the manufacturer (IBM) opted
                         * for a smaller cluster size.
                         */
                        if (!fBPBExists || dbDisk.readUInt8(offBootSector + DiskImage.BPB.CLUSTER_SECS) == DiskImage.aDefaultBPBs[i][DiskImage.BPB.CLUSTER_SECS]) {
                            iBPB = i;
                            break;
                        }
                    }
                }
            }
        }

        let nLogicalSectorsPerTrack = nSectorsPerTrack;

        if (iBPB >= 0) {
            /*
             * Sometimes we come across a physical 360Kb disk image that contains a logical 320Kb image (and similarly,
             * a physical 180Kb disk image that contains a logical 160Kb disk image), presumably because it was possible
             * for someone to take a diskette formatted with 9 sectors/track and then use FORMAT or DISKCOPY to create
             * a smaller file system on it (ie, using only 8 sectors/track).
             */
            if (!bMediaIDBPB) bMediaIDBPB = dbDisk.readUInt8(offBootSector + 512);
            if (iBPB >= 2 && bMediaIDBPB == DiskImage.FAT.MEDIA_320KB && bMediaID == DiskImage.FAT.MEDIA_360KB || bMediaIDBPB == DiskImage.FAT.MEDIA_160KB && bMediaID == DiskImage.FAT.MEDIA_180KB) {
                iBPB -= 2;
                bMediaID = DiskImage.aDefaultBPBs[iBPB][DiskImage.BPB.MEDIA_ID];
                nLogicalSectorsPerTrack = DiskImage.aDefaultBPBs[iBPB][DiskImage.BPB.TRACK_SECS];
                this.printf(Device.MESSAGE.WARN, "shrinking track size to %d sectors/track\n", nLogicalSectorsPerTrack);
            }
            let fBPBWarning = false;
            if (fBPBExists) {
                /*
                 * In deference to the PC DOS 2.0 BPB behavior discussed above, we stop our BPB verification after
                 * the first word of HIDDEN_SECS.
                 */
                for (let off = DiskImage.BPB.SECTOR_BYTES; off < DiskImage.BPB.HIDDEN_SECS + 2; off++) {
                    let bDefault = DiskImage.aDefaultBPBs[iBPB][off];
                    let bActual = dbDisk.readUInt8(offBootSector + off);
                    if (bDefault != bActual) {
                        this.printf(Device.MESSAGE.WARN, "BPB byte %#02bx default (%#02bx) does not match actual byte: %#02bx\n", off, bDefault, bActual);
                        /*
                         * Silly me for thinking that a given media ID (eg, 0xF9) AND a given disk size (eg, 720K)
                         * AND a given number of sectors/cluster (eg, 2) would always map to the same BPB.  I had already
                         * added *two* 720K BPBs -- one for the common case of 2 sectors/cluster and another for 720K
                         * disks like PC DOS 4.01 which use 1 sector/cluster -- but it turns out there are even more
                         * variations.  For example, the number of root directory entries: I was under the impression that
                         * the "standard" value was 0x70, but the number used by PC DOS 3.3 is 0xE0 entries (exactly
                         * twice as many).
                         *
                         * And while it doesn't much matter which BPB variation we use when we're *building* a new disk OR
                         * sprucing up a disk that never had a BPB anyway, it's a much more serious matter when there's
                         * an existing BPB.  So I have narrowed the conditions where fBPBWarning is set, thereby reducing
                         * the odds of damaging a good BPB versus repairing or replacing a bad one.
                         */
                        if (off != DiskImage.BPB.TOTAL_FATS && off != DiskImage.BPB.ROOT_DIRENTS) fBPBWarning = true;
                    }
                }
            }
            if (!fBPBExists || fBPBWarning) {
                if (bByte0 == CPUx86.OPCODE.JMPS && bByte1 >= 0x22 || forceBPB) {
                    /*
                     * I'm going to stick my neck out here and slam a BPB into this disk image, since it doesn't appear
                     * to have one, which should make it more "mountable" on modern operating systems.  PC DOS 1.x (and
                     * the recently unearthed PC DOS 0.x) are OK with this, because they don't put anything important in
                     * the BPB byte range (0x00B-0x023), just a 9-byte date string (eg, " 7-May-81") at 0x008-0x010,
                     * followed by zero bytes at 0x011-0x030.
                     *
                     * They DO, however, store important constants in the range later used as the 8-byte OEM string at
                     * 0x003-0x00A.  For example, the word at 0x006 contains the starting segment for where to load
                     * IBMBIO.COM and IBMDOS.COM.  Those same early boot sectors are also missing the traditional 0xAA55
                     * signature at the end of the boot sector.
                     *
                     * However, if --forceBPB is specified, all those concerns go out the window: the goal is assumed to
                     * be a mountable disk, not a bootable disk.  So the BPB copy starts at offset 0 instead of SECTOR_BYTES.
                     */
                    for (let i = forceBPB? 0 : DiskImage.BPB.SECTOR_BYTES; i < DiskImage.BPB.LARGE_SECS+4; i++) {
                        dbDisk.writeUInt8(DiskImage.aDefaultBPBs[iBPB][i] || 0, offBootSector + i);
                    }
                    this.printf(Device.MESSAGE.INFO, "BPB has been updated\n");
                    if (hash) this.fBPBModified = true;
                }
                else if (bByte0 == 0xF6 && bByte1 == 0xF6 && bMediaIDBPB > 0xF8) {
                    /*
                     * WARNING: I've added this "0xF6" hack expressly to fix boot sectors that may have been zapped by an
                     * inadvertent reformat, or...?  However, certain Xenix diskettes get misdetected by this, so we at least
                     * require the media ID (from the first byte of the first FAT sector) be sensible.
                     */
                    this.printf(Device.MESSAGE.WARN, "repairing damaged boot sector with BPB for media ID %#02bx\n", bMediaID);
                    for (let i = 0; i < DiskImage.BPB.LARGE_SECS+4; i++) {
                        dbDisk.writeUInt8(DiskImage.aDefaultBPBs[iBPB][i] || 0, offBootSector + i);
                    }
                }
                else {
                    this.printf(Device.MESSAGE.WARN, "unrecognized boot sector: %#02bx,%#02bx\n", bByte0, bByte1);
                }
            }
        }

        if (fBPBExists && dbDisk.readUInt16LE(offBootSector + DiskImage.BOOT.SIG_OFFSET) == DiskImage.BOOT.SIGNATURE || forceBPB) {
            /*
             * Overwrite the OEM string with our own, so that people know how the image originated.  We do this
             * only for disks with pre-existing BPBs; it's not safe for pre-2.0 disks (and non-DOS disks, obviously).
             *
             * The signature check is another pre-2.0 disk check, to avoid misinterpreting any BPB that we might have
             * previously added ourselves as an original BPB.
             */
            let dw = dbDisk.readInt32BE(DiskImage.BPB.OEM_STRING + offBootSector);
            if (dw != 0x50434A53) {
                dbDisk.write(DiskImage.PCJS_OEM, DiskImage.BPB.OEM_STRING + offBootSector, DiskImage.PCJS_OEM.length);
                this.printf(Device.MESSAGE.INFO, "OEM string has been updated\n");
                if (hash) this.fBPBModified = true;
            }
        }

        if (!nHeads) {
            /*
             * Next, check for a DSK header (an old private format I used to use, which begins with either
             * 0x00 (read-write) or 0x01 (write-protected), followed by 7 more bytes):
             *
             *      0x01: # heads (1 byte)
             *      0x02: # cylinders (2 bytes)
             *      0x04: # sectors/track (2 bytes)
             *      0x06: # bytes/sector (2 bytes)
             *
             * which may be followed by an array of track table entries if the words at 0x04 and 0x06 are zero.
             * If the track table exists, each entry contains the following:
             *
             *      0x00: # sectors/track (2 bytes)
             *      0x02: # bytes/sector (2 bytes)
             *      0x04: file offset of track data (4 bytes)
             *
             * TODO: Our JSON disk format doesn't explicitly support a write-protect indicator.  Instead, we
             * (used to) include the string "write-protected" as a comment in the first line of the JSON data
             * as a work-around, and if the FDC component sees that comment string, it will honor it; however,
             * we now prefer that read-only disk images simply include a "-readonly" suffix in the filename.
             */
            if (!(bByte0 & 0xFE)) {
                let cbSectorDSK = dbDisk.readUInt16LE(offBootSector + 0x06);
                if (!(cbSectorDSK & (cbSectorDSK - 1))) {
                    cbSector = cbSectorDSK;
                    nHeads = dbDisk.readUInt8(offBootSector + 0x01);
                    nCylinders = dbDisk.readUInt16LE(offBootSector + 0x02);
                    nLogicalSectorsPerTrack = nSectorsPerTrack = dbDisk.readUInt16LE(offBootSector + 0x04);
                    let nTracks = nHeads * nCylinders;
                    cbTrack = nSectorsPerTrack * cbSector;
                    offTrack = 0x08;
                    if (!cbTrack) {
                        for (iTrack = 0; iTrack < nTracks; iTrack++) {
                            nLogicalSectorsPerTrack = nSectorsPerTrack = dbDisk.readUInt16LE(offTrack);
                            cbSectorDSK = dbDisk.readUInt16LE(offTrack+2);
                            cbTrack = nSectorsPerTrack * cbSectorDSK;
                            offSector = dbDisk.readUInt32LE(offTrack+4);
                            dbTrack = dbDisk.slice(offSector, offSector + cbTrack);
                            aTracks[iTrack] = [nSectorsPerTrack, cbSectorDSK, dbTrack];
                            offTrack += 8;
                        }
                    }
                }
            }
        }

        if (nHeads) {
            /*
             * Output the disk data as an array of cylinders, each containing an array of tracks (one track per head),
             * and each track containing an array of sectors.
             */
            iTrack = offTrack = 0;
            cbTrack = nSectorsPerTrack * cbSector;
            let suppObj = this.parseSuppData(suppData);
            this.aDiskData = new Array(nCylinders);
            if (hash) this.hash = hash;
            this.nCylinders = nCylinders;

            for (let iCylinder=0; iCylinder < nCylinders; iCylinder++) {
                let aHeads = new Array(nHeads);
                this.aDiskData[iCylinder] = aHeads;
                this.nHeads = nHeads;

                let offHead = 0;
                for (let iHead=0; iHead < nHeads; iHead++) {
                    if (aTracks.length) {
                        let aTrack = aTracks[iTrack++];
                        nLogicalSectorsPerTrack = nSectorsPerTrack = aTrack[0];
                        cbSector = aTrack[1];
                        dbTrack = aTrack[2];
                        cbTrack = nSectorsPerTrack * cbSector;
                    } else {
                        dbTrack = dbDisk.slice(offTrack + offHead, offTrack + offHead + cbTrack);
                    }

                    let aSectors = new Array(nLogicalSectorsPerTrack);
                    aHeads[iHead] = aSectors;
                    this.nSectors = nLogicalSectorsPerTrack;

                    /*
                     * For most disks, the size of every sector and the number of sectors/track are consistent, and the
                     * sector number encoded in every sector (nSector) matches the 1-based sector index (iSector) we use
                     * to "track" our progress through the current track.  However, for XDF disk images, the above is
                     * NOT true beyond cylinder 0, which is why we have all these *ThisTrack variables, which would otherwise
                     * be unnecessary.
                     */
                    let cbSectorThisTrack = cbSector;
                    let nSectorsThisTrack = nLogicalSectorsPerTrack;
                    this.cbSector = cbSector;

                    /*
                     * Notes regarding XDF track layouts, from http://forum.kryoflux.com/viewtopic.php?f=3&t=234:
                     *
                     *      Track 0, side 0: 19x512 bytes per sector, with standard numbering for the first 8 sectors, then custom numbering
                     *      Track 0, side 1: 19x512 bytes per sector, with interleaved sector numbering 0x81...0x93
                     *
                     *      Track 1 and up, side 0, 4 sectors per track:
                     *      1x1024, 1x512, 1x2048, 1x8192 bytes per sector (0x83, 0x82, 084, 0x86 as sector numbers)
                     *
                     *      Track 1 and up, side 1, 4 sectors per track:
                     *      1x2048, 1x512, 1x1024, 1x8192 bytes per sector (0x84, 0x82, 083, 0x86 as sector numbers)
                     *
                     * Notes regarding the order in which XDF sectors are read (from http://mail.netbridge.at/cgi-bin/info2www?(fdutils)XDF),
                     * where each position column represents a (roughly) 128-byte section of the track:
                     *
                     *          1         2         3         4
                     * 1234567890123456789012345678901234567890 (position)
                     * ----------------------------------------
                     * 6633332244444446666666666666666666666666 (side 0)
                     * 6666444444422333366666666666666666666666 (side 1)
                     *
                     * where 2's contain a 512-byte sector, 3's contain a 1Kb sector, 4's contains a 2Kb sector, and 6's contain an 8Kb sector.
                     *
                     * Reading all the data on an XDF cylinder occurs in the following order, from the specified start to end positions:
                     *
                     *     sector    head   start     end
                     *          3       0       3       7
                     *          4       0       9      16
                     *          6       1      18       5 (1st wrap around)
                     *          2       0       7       9
                     *          2       1      12      14
                     *          6       0      16       3 (2nd wrap around)
                     *          4       1       5      12
                     *          3       1      14      18
                     */
                    if (fXDFOutput) nSectorsThisTrack = (iCylinder? 4 : 19);

                    let suppTrack = null;
                    for (let iSector=1, offSector=0; iSector <= nSectorsThisTrack && (offSector < cbTrack || suppTrack); iSector++, offSector += cbSectorThisTrack) {

                        let sectorID = iSector;

                        if (fXDFOutput && iCylinder) {
                            if (!iHead) {
                                cbSectorThisTrack = (iSector == 1? 1024 : (iSector == 2? 512 : (iSector == 3? 2048 : 8192)));
                            } else {
                                cbSectorThisTrack = (iSector == 1? 8192 : (iSector == 2? 2048 : (iSector == 3? 1024 : 512)));
                            }
                            sectorID = (cbSectorThisTrack == 512? 2 : (cbSectorThisTrack == 1024? 3 : (cbSectorThisTrack == 2048? 4 : 6)));
                        }

                        /*
                         * Check for any sector ID edits that must be applied to the disk (eg, "--sectorID=C:H:S:ID").
                         *
                         * For example, when building the IBM Multiplan 1.00 Program disk, "--sectorID=11:0:8:61" must be specified.
                         */
                        let aParts, n;
                        if (sectorIDs) {
                            let aSectorIDs = (typeof sectorIDs == "string")? [sectorIDs] : sectorIDs;
                            for (let i = 0; i < aSectorIDs.length; i++) {
                                aParts = aSectorIDs[i].split(":");
                                if (+aParts[0] === iCylinder && +aParts[1] === iHead && +aParts[2] === sectorID) {
                                    n = +aParts[3];
                                    if (!isNaN(n)) {
                                        sectorID = n;
                                        this.printf(Device.MESSAGE.WARN, "changing %d:%d:%d sectorID to %d\n", +aParts[0], +aParts[1], +aParts[2], sectorID);
                                    }
                                }
                            }
                        }
                        let sectorError = 0;
                        if (sectorErrors) {
                            let aSectorErrors = (typeof sectorErrors == "string")? [sectorErrors] : sectorErrors;
                            for (let i = 0; i < aSectorErrors.length; i++) {
                                aParts = aSectorErrors[i].split(":");
                                if (+aParts[0] === iCylinder && +aParts[1] === iHead && +aParts[2] === sectorID) {
                                    n = +aParts[3] || -1;
                                    if (n) {
                                        sectorError = n;
                                        this.printf(Device.MESSAGE.WARN, "forcing error for sector %d:%d:%d at %d bytes\n", +aParts[0], +aParts[1], +aParts[2], sectorError);
                                    }
                                }
                            }
                        }

                        dbSector = dbTrack.slice(offSector, offSector + cbSectorThisTrack);

                        if (bMediaID && !iCylinder && !iHead && iSector == ((offBootSector/cbSector)|0) + 2) {
                            let bFATID = dbSector.readUInt8(0);
                            if (bMediaID != bFATID) {
                                this.printf(Device.MESSAGE.WARN, "FAT ID (%#02bx) does not match physical media ID (%#02bx)\n", bFATID, bMediaID);
                            }
                            bMediaID = 0;
                        }

                        let sector = this.buildSector(iCylinder, iHead, sectorID, cbSectorThisTrack, dbSector);

                        let suppSector = null;
                        if (suppObj[iCylinder]) {
                            suppTrack = suppObj[iCylinder][iHead];
                            if (suppTrack) {
                                suppSector = suppTrack[iSector-1];
                                nSectorsThisTrack = suppTrack.length;
                            }
                        }

                        if (suppSector) {
                            sector[DiskImage.SECTOR.ID] = suppSector['sectorID'];
                            if (suppSector['length']) sector[DiskImage.SECTOR.LENGTH] = suppSector['length'];
                            if (suppSector['headCRC']) sector[DiskImage.SECTOR.HEAD_CRC] = suppSector['headCRC'];
                            if (suppSector['headError']) sector[DiskImage.SECTOR.HEAD_ERROR] = true;
                            if (suppSector['dataCRC']) sector[DiskImage.SECTOR.DATA_CRC] = suppSector['dataCRC'];
                            if (suppSector['dataMark']) sector[DiskImage.SECTOR.DATA_MARK] = suppSector['dataMark'];
                            if (!sectorError) sectorError = suppSector['dataError'];
                            sector[DiskImage.SECTOR.DATA] = suppSector['data'];
                        }

                        if (sectorError) sector[DiskImage.SECTOR.DATA_ERROR] = sectorError;

                        aSectors[iSector - 1] = sector;

                        this.cbDiskData += sector[DiskImage.SECTOR.LENGTH];
                    }
                    offHead += cbTrack;         // end of head {iHead}, track {iCylinder}
                }
                offTrack += offHead;            // end of cylinder {iCylinder}
            }
            return true;
        }
        // else if (dbDisk.readUInt16BE(0x900) == 0x4357) {
        //     return this.convertOSIDiskToJSON();
        // }
        return false;
    }

    /**
     * buildDiskFromFiles(dbDisk, diskName, aFileData, kbTarget)
     *
     * @this {DiskImage}
     * @param {DataBuffer} dbDisk
     * @param {string} diskName
     * @param {Array.<FileData>} aFileData
     * @param {number} [kbTarget]
     * @returns {boolean} true if disk allocation successful, false if not
     */
    buildDiskFromFiles(dbDisk, diskName, aFileData, kbTarget = 0)
    {
        if (!aFileData || !aFileData.length) {
            return false;
        }

        this.diskName = diskName;
        this.abOrigBPB = [];
        this.fBPBModified = false;

        /*
         * Put reasonable upper limits on both individual file sizes and the total size of all files.
         */
        let cbMax = (kbTarget || 1440) * 1024;
        let nTargetSectors = (kbTarget? kbTarget * 2 : 0);

        /*
         * This initializes cbTotal assuming a "best case scenario" (ie, one sector per cluster); as soon as
         * we find a BPB that will support that size, we recalculate cbTotal using that BPB's cluster size, and
         * then we re-verify that that BPB will work.  If not, then we keep looking.
         */
        let cbTotal = this.calcFileSizes(aFileData);

        this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "calculated size for %d files: %d bytes (%#x)\n", aFileData.length, cbTotal);

        if (cbTotal >= cbMax) {
            this.printf(Device.MESSAGE.DISK + Device.MESSAGE.ERROR, "file(s) too large (%d bytes total, %d bytes maximum)\n", cbTotal, cbMax);
            return false;
        }

        let iBPB, abBoot, cbSector, cSectorsPerCluster, cbCluster, cFATs, cFATSectors;
        let cRootEntries, cRootSectors, cTotalSectors, cHiddenSectors, cSectorsPerTrack, cHeads, cDataSectors, cbAvail;

        /*
         * Find or build a BPB with enough capacity, and at the same time, calculate all the other values we'll need,
         * including total number of data sectors (cDataSectors).
         *
         * TODO: For now, the code that chooses a default BPB starts with entry #3 instead of #0, because Windows 95
         * (at least when running under VMware) fails to read the contents of such disks correctly.  Whether that's my
         * fault or Windows 95's fault is still TBD (although it's probably mine -- perhaps 160Kb diskettes aren't
         * supposed to have BPBs?)  The simple work-around is to avoid creating 160Kb diskette images used by PC DOS 1.0.
         * To play it safe, I also skip the 320Kb format (added for PC DOS 1.1).  360Kb was the most commonly used format
         * after PC DOS 2.0 introduced it.  PC DOS 2.0 also introduced 180Kb (a single-sided version of the 360Kb
         * double-sided format), but it's less commonly used.
         *
         * UPDATE: I've undone the above change, because when creating a disk image for an old application like:
         *
         *      /apps/pcx86/1983/adventmath ["Adventures in Math (1983)"]
         *
         * it's important to create a disk image that will work with PC DOS 1.0, which didn't understand 180Kb and 360Kb
         * disk images.
         */
        for (iBPB = 0; iBPB < DiskImage.aDefaultBPBs.length; iBPB++) {
            /*
             * Use slice() to copy the BPB, to ensure we don't alter the original.
             */
            abBoot = DiskImage.aDefaultBPBs[iBPB].slice();
            /*
             * If this BPB is for a hard drive but a disk size was not specified, skip it.
             */
            if ((abBoot[DiskImage.BPB.MEDIA_ID] == DiskImage.FAT.MEDIA_FIXED) != (kbTarget >= 10000)) continue;
            cRootEntries = abBoot[DiskImage.BPB.ROOT_DIRENTS] | (abBoot[DiskImage.BPB.ROOT_DIRENTS + 1] << 8);
            if (aFileData.length > cRootEntries) continue;
            cbSector = abBoot[DiskImage.BPB.SECTOR_BYTES] | (abBoot[DiskImage.BPB.SECTOR_BYTES + 1] << 8);
            cSectorsPerCluster = abBoot[DiskImage.BPB.CLUSTER_SECS];
            cbCluster = cbSector * cSectorsPerCluster;
            cFATs = abBoot[DiskImage.BPB.TOTAL_FATS];
            cFATSectors = abBoot[DiskImage.BPB.FAT_SECS] | (abBoot[DiskImage.BPB.FAT_SECS + 1] << 8);
            cRootSectors = (((cRootEntries * DiskImage.DIRENT.LENGTH) + cbSector - 1) / cbSector) | 0;
            cTotalSectors = abBoot[DiskImage.BPB.TOTAL_SECS] | (abBoot[DiskImage.BPB.TOTAL_SECS + 1] << 8);
            cHiddenSectors = abBoot[DiskImage.BPB.HIDDEN_SECS] | (abBoot[DiskImage.BPB.HIDDEN_SECS + 1] << 8);
            cSectorsPerTrack = abBoot[DiskImage.BPB.TRACK_SECS] | (abBoot[DiskImage.BPB.TRACK_SECS + 1] << 8);
            cHeads = abBoot[DiskImage.BPB.TOTAL_HEADS] | (abBoot[DiskImage.BPB.TOTAL_HEADS + 1] << 8);
            cDataSectors = cTotalSectors - (cRootSectors + cFATs * cFATSectors + 1);
            cbAvail = cDataSectors * cbSector;
            if (!nTargetSectors || cHiddenSectors) {
                if (cbTotal <= cbAvail) {
                    let cb = this.calcFileSizes(aFileData, cSectorsPerCluster);
                    if (cb <= cbAvail) {
                        cbTotal = cb;
                        break;
                    }
                }
            } else {
                if (cTotalSectors == nTargetSectors) break;
            }
        }

        if (iBPB == DiskImage.aDefaultBPBs.length) {
            this.printf(Device.MESSAGE.DISK + Device.MESSASGE.ERROR, "too many file(s) for disk image (%d files, %d bytes)\n", aFileData.length, cbTotal);
            return false;
        }

        let abSector;
        let offDisk = 0;
        let cbDisk = cTotalSectors * cbSector;

        /*
         * If the disk is actually a partition on a larger drive, calculate how much larger the image should be
         * (ie, hidden sectors plus an entire cylinder reserved for diagnostics, head parking, etc).
         */
        let cbDrive = (cHiddenSectors? (cHiddenSectors + cSectorsPerTrack * cHeads) * cbSector : 0) + cbDisk;

        /*
         * TODO: Consider doing what convertToIMG() did, which was deferring setting dbDisk until the
         * buffer is fully (and successfully) initialized.  Here, however, the build process relies on worker
         * functions that prefer not passing around temporary buffers.  In the meantime, perhaps any catastrophic
         * failures should set dbDisk back to null?
         */
        dbDisk.new(cbDrive);

        /*
         * WARNING: Buffers are NOT zero-initialized, so we need explicitly fill dbDisk with zeros (this seems
         * to be a reversal in the trend to zero buffers, when security concerns would trump performance concerns).
         */
        dbDisk.fill(0);

        /*
         * Output a Master Boot Record (MBR) if this is a hard drive image.
         */
        if (cHiddenSectors) {
            abSector = this.buildMBR(cHeads, cSectorsPerTrack, cbSector, cTotalSectors);
            offDisk += this.copyData(dbDisk, offDisk, abSector) * cHiddenSectors;
        }

        /*
         * Output a boot sector.
         */
        abBoot[DiskImage.BOOT.SIG_OFFSET] = DiskImage.BOOT.SIGNATURE & 0xff;            // 0x55
        abBoot[DiskImage.BOOT.SIG_OFFSET + 1] = (DiskImage.BOOT.SIGNATURE >> 8) & 0xff; // 0xAA
        abSector = this.buildData(cbSector, abBoot);
        offDisk += this.copyData(dbDisk, offDisk, abSector);

        /*
         * Build the FAT, noting the starting cluster number that each file will use along the way.
         *
         * Also, notice that the first byte of the FAT is the "media ID" byte that's replicated in the
         * BPB at offset 0x15.  For old BPB-less diskettes, this is where you must look for the media ID.
         */
        let abFAT = [];
        this.buildFATEntry(abFAT, 0, abBoot[DiskImage.BPB.MEDIA_ID] | 0xF00);
        this.buildFATEntry(abFAT, 1, 0xFFF);
        this.buildFAT(abFAT, aFileData, 2, cbCluster);

        /*
         * Output the FAT sectors; we simplify the logic a bit by writing each FAT table as if it
         * were one giant sector.
         */
        while (cFATs--) {
            abSector = this.buildData(cFATSectors * cbSector, abFAT);
            offDisk += this.copyData(dbDisk, offDisk, abSector);
        }

        /*
         * Build the root directory
         */
        let abRoot = [];
        let cEntries = this.buildDir(abRoot, aFileData);

        /*
         * PC DOS 1.0 requires ALL unused directory entries to start with 0xE5; 0x00 isn't good enough,
         * so we must loop through all the remaining directory entries and zap them with 0xE5.
         */
        let offRoot = cEntries * DiskImage.DIRENT.LENGTH;
        while (cEntries++ < cRootEntries) {
            abRoot[offRoot] = DiskImage.DIRENT.INVALID;         // 0xE5
            offRoot += DiskImage.DIRENT.LENGTH;                 // 0x20 (32)
        }

        /*
         * Output the root directory sectors (as before, as if they were one giant sector)
         */
        abSector = this.buildData(cRootSectors * cbSector, abRoot);
        offDisk += this.copyData(dbDisk, offDisk, abSector);

        /*
         * Output the file data clusters, which must be stored sequentially, mirroring the order in which
         * we wrote the cluster sequences to the FAT, above.
         */
        let cClusters = this.buildClusters(dbDisk, aFileData, offDisk, cbCluster, 0, 0);
        offDisk += cClusters * cSectorsPerCluster * cbSector;

        this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%d bytes written, %d bytes available\n", offDisk, cbDisk);

        if (offDisk > cbDisk) {
            this.printf(Device.MESSAGE.DISK + Device.MESSAGE.ERROR, "too much data for disk image (%d clusters required)\n", cClusters);
            return false;
        }

        return this.buildDiskFromBuffer(dbDisk);
    }

    /**
     * calcFileSizes(aFileData, cSectorsPerCluster)
     *
     * @this {DiskImage}
     * @param {Array.<FileData>} aFileData
     * @param {number} [cSectorsPerCluster] (default is 1)
     * @returns {number} of bytes required for all files, including all subdirectories
     */
    calcFileSizes(aFileData, cSectorsPerCluster)
    {
        let cbTotal = 0;
        let cbCluster = (cSectorsPerCluster || 1) * 512;
        for (let iFile = 0; iFile < aFileData.length; iFile++) {
            let cb = aFileData[iFile].size;
            let cbSubTotal = 0;
            if (cb < 0) {
                cb = (aFileData[iFile].files.length + 2) * 32;
                cbSubTotal = this.calcFileSizes(aFileData[iFile].files, cSectorsPerCluster);
            }
            cbTotal += cb;
            if ((cb %= cbCluster)) {
                cbTotal += cbCluster - cb;
            }
            cbTotal += cbSubTotal;
        }
        return cbTotal;
    }

    /**
     * buildData(cb)
     *
     * @this {DiskImage}
     * @param {number} cb
     * @param {Array.<number>} [abInit]
     * @returns {Array.<number>} of bytes, initialized with abInit (or with zero when abInit is empty or exhausted)
     */
    buildData(cb, abInit)
    {
        let ab = new Array(cb);
        for (let i = 0; i < cb; i++) {
            ab[i] = abInit && abInit[i] || 0;
        }
        return ab;
    }

    /**
     * copyData(db, offset, ab)
     *
     * @this {DiskImage}
     * @param {BufferData} db
     * @param {number} offset
     * @param {Array.<number>} ab
     * @returns {number} number of bytes written
     */
    copyData(db, offset, ab)
    {
        db.fill(ab, offset, offset + ab.length);
        return ab.length;
    }

    /**
     * buildClusters(dbDisk, aFileData, offDisk, cbCluster, iParentCluster, done)
     *
     * @this {DiskImage}
     * @param {DataBuffer} dbDisk
     * @param {Array.<FileData>} aFileData
     * @param {number} offDisk
     * @param {number} cbCluster
     * @param {number} iParentCluster
     * @param {number} iLevel
     * @param {function(Error)} done
     * @returns {number} number of clusters built
     */
    buildClusters(dbDisk, aFileData, offDisk, cbCluster, iParentCluster, iLevel)
    {
        let cSubDirs = 0;
        let cClusters = 0;

        for (let iFile = 0; iFile < aFileData.length; iFile++) {
            let dbData = aFileData[iFile].data;
            let cbData = aFileData[iFile].size;
            if (cbData > 0) {
                this.assert(cbData == dbData.length);
            }
            else if (cbData < 0) {
                let abData = [];
                cbData = this.buildDir(abData, aFileData[iFile].files, aFileData[iFile].date, aFileData[iFile].cluster, iParentCluster) * 32;
                dbData.new(cbData);
                dbData.fill(abData);
                cSubDirs++;
            }
            if (cbData) {
                dbData.copy(dbDisk, offDisk);
                if (Device.DEBUG) this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%#x: %#x bytes written for %s\n", offDisk, dbData.length, aFileData[iFile].path);
            }
            offDisk += cbData;
            cClusters += ((cbData / cbCluster) | 0);
            let cbPartial = (cbData % cbCluster);
            if (cbPartial) {
                cbPartial = cbCluster - cbPartial;
                offDisk += cbPartial;
                cClusters++;
            }
        }

        if (cSubDirs > 0) {
            for (let iFile = 0; iFile < aFileData.length; iFile++) {
                let cb = aFileData[iFile].size;
                if (cb < 0) {
                    if (Device.DEBUG) this.printf("%#x: buildClusters()\n", offDisk);
                    let cSubClusters = this.buildClusters(dbDisk, aFileData[iFile].files, offDisk, cbCluster, aFileData[iFile].cluster, iLevel + 1);
                    cClusters += cSubClusters;
                    offDisk += cSubClusters * cbCluster;
                    if (Device.DEBUG) this.printf("%#x: buildClusters() returned, writing %d clusters\n", offDisk, cSubClusters);
                }
            }
        }

        return cClusters;
    }

    /**
     * buildDateTime(dateMod)
     *
     * @this {DiskImage}
     * @param {Date} dateMod contains the modification time of a file
     * @returns {number} the time (bits 0-15) and date (bits 16-31) in FAT format
     */
    buildDateTime(dateMod)
    {
        let year = dateMod.getFullYear();
        let month = dateMod.getMonth() + 1;
        let day = dateMod.getDate();
        let time = ((dateMod.getHours() & 0x1F) << 11) | ((dateMod.getMinutes() & 0x3F) << 5) | ((dateMod.getSeconds() >> 1) & 0x1F);
        /*
         * NOTE: If validateTime() is doing its job, then we should never have to do this.  This is simple paranoia.
         */
        if (year < 1980) {
            year = 1980; month = 1; day = 1; time = 1;
        } else if (year > 2099) {
            year = 2099; month = 12; day = 31; time = 1;
        }
        let date = (((year - 1980) & 0x7F) << 9) | (month << 5) | day;
        return ((date & 0xffff) << 16) | (time & 0xffff);
    }

    /**
     * buildDir(abDir, aFileData, dateMod, iCluster, iParentCluster)
     *
     * @this {DiskImage}
     * @param {Array.<number>} abDir
     * @param {Array.<FileData>} aFileData
     * @param {Date} [dateMod]
     * @param {number} [iCluster]
     * @param {number} [iParentCluster]
     * @returns {number} number of directory entries built
     */
    buildDir(abDir, aFileData, dateMod, iCluster, iParentCluster)
    {
        if (dateMod === undefined) dateMod = null;
        if (iCluster === undefined) iCluster = -1;
        if (iParentCluster === undefined) iParentCluster = -1;

        let offDir = 0;
        let cEntries = 0;
        if (iCluster >= 0) {
            offDir += this.buildDirEntry(abDir, offDir, ".", 0, DiskImage.ATTR.SUBDIR, dateMod, iCluster);
            offDir += this.buildDirEntry(abDir, offDir, "..", 0, DiskImage.ATTR.SUBDIR, dateMod, iParentCluster);
            cEntries += 2;
        }
        for (let iFile = 0; iFile < aFileData.length; iFile++) {
            let file = aFileData[iFile];
            if (file.cluster === undefined) {
                this.printf(Device.MESSAGE.DISK, "file %s missing cluster, skipping\n", file.name);
                continue;
            }
            let name = this.buildShortName(file.name, !!(file.attr & DiskImage.ATTR.VOLUME));
            offDir += this.buildDirEntry(abDir, offDir, name, file.size, file.attr, file.date, file.cluster);
            cEntries++;
        }
        return cEntries;
    }

    /**
     * buildDirEntry(ab, off, sName, cbFile, bAttr, dateMod, iCluster)
     *
     * TODO: Create constants that define the various directory entry fields, including the overall size (32 bytes).
     *
     * @this {DiskImage}
     * @param {Array.<number>} ab contains the bytes of a directory
     * @param {number} off is the offset within ab to build the next directory entry
     * @param {string} sName is the file name
     * @param {number} cbFile is the size of the file, in bytes
     * @param {number} bAttr contains the attribute bits of the file
     * @param {Date} dateMod contains the modification date of the file
     * @param {number} iCluster is the starting cluster of the file
     * @returns {number} number of bytes added to the directory (normally 32)
     */
    buildDirEntry(ab, off, sName, cbFile, bAttr, dateMod, iCluster)
    {
        let sExt = "";
        let offDir = off;
        let i = sName.indexOf('.');
        if (i > 0) {
            sExt = sName.substr(i+1);
            sName = sName.substr(0, i);
        }
        for (i = 0; i < 8; i++) {
            ab[off++] = (i < sName.length? sName.charCodeAt(i) : 0x20);
        }
        for (i = 0; i < 3; i++) {
            ab[off++] = (i < sExt.length? sExt.charCodeAt(i) : 0x20);
        }

        /*
         * File attribute bits at offset 0x0B are next: (0x01 for read-only, 0x02 for hidden, 0x04 for system,
         * 0x08 for volume label, 0x10 for subdirectory, and 0x20 for archive)
         */
        ab[off++] = bAttr;

        /*
         * Skip 10 bytes, bringing us to offset 0x16: 2 bytes for modification time, plus 2 bytes for modification date.
         */
        off += 10;
        if (dateMod) {
            let dateTime = this.buildDateTime(dateMod);
            ab[off++] = dateTime & 0xff;
            ab[off++] = (dateTime >> 8) & 0xff;
            dateTime >>= 16;
            ab[off++] = dateTime & 0xff;
            ab[off++] = (dateTime >> 8) & 0xff;
        } else {
            for (i = 0; i < 4; i++) ab[off++] = 0;
        }

        /*
         * Now we're at offset 0x1A, where the starting cluster (2 bytes) and file size (4 bytes) are stored,
         * completing the 32-byte directory entry.
         */
        ab[off++] = iCluster & 0xff;                // first file cluster (low byte)
        ab[off++] = (iCluster >> 8) & 0xff;         // first file cluster (high byte)

        /*
         * For subdirectories, we recorded a -1 rather than a 0, because unlike true 0-length files, they DO actually
         * have a size, it's just not immediately known until we traverse the directory's contents.  However, when it
         * comes time to the write the directory entry for a subdirectory, the FAT convention is to record it as zero.
         */
        if (cbFile < 0) cbFile = 0;
        ab[off++] = cbFile & 0xff;
        ab[off++] = (cbFile >> 8) & 0xff;
        ab[off++] = (cbFile >> 16) & 0xff;
        ab[off++] = (cbFile >> 24) & 0xff;

        return off - offDir;
    }

    /**
     * buildFAT(abFAT, aFileData, iCluster, cbCluster)
     *
     * @this {DiskImage}
     * @param {Array.<number>} abFAT
     * @param {Array.<FileData>} aFileData
     * @param {number} iCluster
     * @param {number} cbCluster
     * @returns {number}
     */
    buildFAT(abFAT, aFileData, iCluster, cbCluster)
    {
        let cb;
        let cSubDirs = 0;
        for (let iFile = 0; iFile < aFileData.length; iFile++) {
            cb = aFileData[iFile].size;
            if (cb < 0) {
                cb = (aFileData[iFile].files.length + 2) * 32;
                cSubDirs++;
            }
            let cFileClusters = ((cb + cbCluster - 1) / cbCluster) | 0;
            if (!cFileClusters) {
                aFileData[iFile].cluster = 0;
            } else {
                aFileData[iFile].cluster = iCluster;
                while (cFileClusters-- > 0) {
                    let iNextCluster = iCluster + 1;
                    if (!cFileClusters) iNextCluster = 0xFFF;
                    this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%s: setting cluster entry %d to %#0wx\n", aFileData[iFile].name, iCluster, iNextCluster);
                    this.buildFATEntry(abFAT, iCluster++, iNextCluster);
                }
            }
        }
        if (cSubDirs) {
            for (let iFile = 0; iFile < aFileData.length; iFile++) {
                cb = aFileData[iFile].size;
                if (cb < 0) {
                    iCluster = this.buildFAT(abFAT, aFileData[iFile].files, iCluster, cbCluster);
                }
            }
        }
        return iCluster;
    }

    /**
     * buildFATEntry(abFat, iFat, v)
     *
     * @this {DiskImage}
     * @param {Array.<number>} abFAT
     * @param {number} iFAT
     * @param {number} v
     */
    buildFATEntry(abFAT, iFAT, v)
    {
        let iBit = iFAT * 12;
        let iByte = (iBit >> 3);
        if ((iBit % 8) === 0) {
            abFAT[iByte] = v & 0xff;
            iByte++;
            if (abFAT[iByte] === undefined) abFAT[iByte] = 0;
            abFAT[iByte] = (abFAT[iByte] & 0xF0) | (v >> 8);
        }
        else {
            if (abFAT[iByte] === undefined) abFAT[iByte] = 0;
            abFAT[iByte] = (abFAT[iByte] & 0x0F) | ((v & 0xF) << 4);
            abFAT[iByte + 1] = (v >> 4);
        }
    }

    /**
     * buildMBR(cHeads, cSectorsPerTrack, cbSector, cTotalSectors)
     *
     * @this {DiskImage}
     * @param {number} cHeads
     * @param {number} cSectorsPerTrack
     * @param {number} cbSector
     * @param {number} cTotalSectors
     * @returns {Array.<number>}
     */
    buildMBR(cHeads, cSectorsPerTrack, cbSector, cTotalSectors)
    {
        /*
         * There are four 16-byte partition entries in the MBR, starting at offset 0x1BE,
         * but we need only one, and like DOS 2.0, we'll use the last one, at offset 0x1EE.
         */
        let offSector = 0x1EE;
        let abSector = this.buildData(cbSector);

        /*
         * Next 1 byte: status + physical drive #
         */
        abSector[offSector++] = 0x80;           // 0x80 indicates an active partition entry

        /*
         * Next 3 bytes: CHS (Cylinder/Head/Sector) of first partition sector
         */
        abSector[offSector++] = 0x00;           // head: 0
        abSector[offSector++] = 0x02;           // sector: 1 (bits 0-5), cyclinder bits 8-9: 0 (bits 6-7)
        abSector[offSector++] = 0x00;           // cylinder bits 0-7: 0

        /*
         * Next 1 byte: partition ID
         */
        abSector[offSector++] = 0x01;           // partition ID: 0x01 (FAT12)

        /*
         * Next 3 bytes: CHS (Cylinder/Head/Sector) of last partition sector
         */
        abSector[offSector++] = cHeads-1;
        let cCylinders = (cTotalSectors / (cHeads * cSectorsPerTrack)) | 0;
        abSector[offSector++] = cSectorsPerTrack | ((cCylinders & 0x300) >> 2);
        abSector[offSector++] = cCylinders & 0xff;

        /*
         * Next 4 bytes: LBA (Logical Block Address) of first partition sector
         */
        abSector[offSector++] = 1;
        abSector[offSector++] = 0x00;
        abSector[offSector++] = 0x00;
        abSector[offSector++] = 0x00;

        /*
         * Next 4 bytes: Number of sectors in partition
         */
        abSector[offSector++] = (cTotalSectors & 0xff);
        abSector[offSector++] = ((cTotalSectors >> 8) & 0xff);
        abSector[offSector++] = ((cTotalSectors >> 16) & 0xff);
        abSector[offSector++] = ((cTotalSectors >> 24) & 0xff);

        /*
         * Since we should be at offset 0x1FE now, store the MBR signature bytes
         */
        abSector[offSector++] = 0x55;
        abSector[offSector] = 0xAA;
        return abSector;
    }

    /**
     * buildShortName(sFile, fLabel)
     *
     * @this {DiskImage}
     * @param {string} sFile is the basename of a file
     * @param {boolean} [fLabel]
     * @return {string} containing a corresponding filename in FAT "8.3" format
     */
    buildShortName(sFile, fLabel)
    {
        let sName = sFile.toUpperCase();
        let iExt = sName.lastIndexOf('.');
        let sExt = "";
        if (iExt >= 0) {
            sExt = sName.substr(iExt+1);
            sName = sName.substr(0, iExt);
        } else if (fLabel && sName.length > 8) {
            sExt = sName.substr(8);
        }
        sName = sName.substr(0, 8).trim();
        sExt = sExt.substr(0, 3).trim();
        let iPeriod = -1;
        if (sExt) {
            iPeriod = sName.length;
            sName += '.' + sExt;
        }
        for (let i = 0; i < sName.length; i++) {
            if (i == iPeriod) continue;
            let ch = sName.charAt(i);
            if ("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'()-@^_`{}~".indexOf(ch) < 0) {
                sName = sName.substr(0, i) + '_' + sName.substr(i+1);
            }
        }
        return sName;
    }

    /**
     * buildDiskFromJSON(sData)
     *
     * Build a disk image from JSON data.
     *
     * @this {DiskImage}
     * @param {string} sData
     * @returns {boolean} true if successful (aDiskData initialized); false otherwise
     */
    buildDiskFromJSON(sData)
    {
        this.aDiskData = null;
        this.cbDiskData = 0;
        this.dwChecksum = 0;
        this.fromJSON = false;

        this.abOrigBPB = [];
        this.fBPBModified = false;

        let imageData;
        try {
            imageData = JSON.parse(sData);
            if (imageData) {
                /*
                 * We must now differentiate between "legacy" JSON images (which were simply arrays of CHS sector data)
                 * and "extended" JSON images, which are objects with a CHS "diskData" property, among other things.
                 */
                let imageInfo = imageData[DiskImage.DESC.IMAGE];
                if (imageInfo) {
                    let sOrigBPB = imageInfo[DiskImage.IMAGE.ORIGBPB];
                    if (sOrigBPB) this.abOrigBPB = JSON.parse(sOrigBPB);
                    if (!this.volTable.length && imageData.volTable) {
                        this.volTable = imageData.volTable;
                    }
                    this.buildFileTableFromJSON(imageData[DiskImage.DESC.FILES]);
                    this.fromJSON = true;
                }
                let aDiskData = imageData[DiskImage.DESC.DISKDATA] || imageData;
                if (aDiskData && aDiskData.length) {
                    let aCylinders = this.aDiskData = aDiskData;
                    this.nCylinders = aCylinders.length;
                    this.nSectors = this.cbSector = 0;
                    for (let iCylinder = 0; iCylinder < aCylinders.length; iCylinder++) {
                        let aHeads = aCylinders[iCylinder];
                        this.nHeads = aHeads.length
                        for (let iHead = 0; iHead < aHeads.length; iHead++) {
                            let aSectors = aHeads[iHead];
                            let nSectors = aSectors.length;
                            if (!this.nSectors) {
                                this.nSectors = nSectors;
                            } else if (this.nSectors != nSectors) {
                                this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%s: %d:%d contains varying sectors per track: %d\n", this.diskName, iCylinder, iHead, nSectors);
                            }
                            for (let iSector = 0; iSector < aSectors.length; iSector++) {
                                let sector = aSectors[iSector];
                                this.rebuildSector(iCylinder, iHead, sector);
                                let cbSector = sector[DiskImage.SECTOR.LENGTH];
                                if (!this.cbSector) {
                                    this.cbSector = cbSector;
                                } else if (this.cbSector != cbSector) {
                                    this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%s: %d:%d:%d contains varying sector sizes: %d\n", this.diskName, iCylinder, iHead, sector[DiskImage.SECTOR.ID], cbSector);
                                }
                                this.cbDiskData += cbSector;
                            }
                        }
                    }
                    return true;
                }
            }
        } catch(err) {
            this.printf(Device.MESSAGE.ERROR, "error: %s\n", err.message);
        }
        return false;
    }

    /**
     * buildDiskFromPSI()
     *
     * Build disk image from a PSI file.
     *
     * PSI files are PCE Sector Image files; see https://github.com/jeffpar/pce/blob/master/doc/psi-format.txt for details.
     *
     * @this {DiskImage}
     * @param {DataBuffer} dbDisk
     * @returns {boolean} true if successful (aDiskData initialized); false otherwise
     */
    buildDiskFromPSI(dbDisk)
    {
        this.aDiskData = null;
        this.cbDiskData = 0;

        this.abOrigBPB = [];
        this.fBPBModified = false;

        let data = [];
        let chunkOffset = 0;
        let chunkEnd = dbDisk.length;
        let chunkID, chunkSize = 0, dbChunk;

        let CHUNK_PSI  = 0x50534920;
        let CHUNK_END  = 0x454e4420;
        let CHUNK_SECT = 0x53454354;
        let CHUNK_OFFS = 0x4f464653;
        let CHUNK_IBMM = 0x49424d4d;    // "IBMM": IBM MFM sector header
        let CHUNK_TEXT = 0x54455854;
        let CHUNK_DATA = 0x44415441;

        let getCRC = function(start, end) {
            let crc = 0;
            for (let i = start; i < end; i++) {
                crc ^= dbDisk.readUInt8(i) << 24;
                for (let j = 0; j < 8; j++) {
                    if (crc & 0x80000000) {
                        crc = (crc << 1) ^ 0x1edc6f41;
                    } else {
                        crc = crc << 1;
                    }
                }
            }
            return crc | 0;
        };

        let getNextChunk = function() {
            if (chunkSize) chunkOffset += chunkSize + 12;
            chunkID = dbDisk.readUInt32BE(chunkOffset);
            chunkSize = dbDisk.readUInt32BE(chunkOffset + 4);
            let chunkCRC = dbDisk.readInt32BE(chunkOffset + 8 + chunkSize);
            let myCRC = getCRC(chunkOffset, chunkOffset + 8 + chunkSize);
            if (chunkCRC == myCRC) {
                dbChunk = dbDisk.slice(chunkOffset + 8, chunkOffset + 8 + chunkSize);
            } else {
                this.printf(Device.MESSAGE.WARN, "chunk 0x%x at 0x%x: CRC 0x%x != calculated CRC 0x%x\n", chunkID, chunkOffset, chunkCRC, myCRC);
                chunkID = CHUNK_END;
            }
        };

        getNextChunk();

        if (chunkID != CHUNK_PSI) {
            this.printf(Device.MESSAGE.WARN, "missing PSI header\n");
            chunkEnd = 0;
        }

        let fileFormat = dbChunk.readUInt16BE(0);
        let sectorFormat = dbChunk.readUInt16BE(2);
        let cylinder, head, idSector, size, flags, pattern, sector, sectorIndex, maxIndex;

        this.printf(Device.MESSAGE.INFO, "file format: 0x%04x\nsector format: 0x%02x 0x%02x\n", fileFormat, sectorFormat >> 8, sectorFormat & 0xff);

        while (chunkOffset < chunkEnd) {
            getNextChunk();
            switch(chunkID) {

            case CHUNK_SECT:
                cylinder = dbChunk.readUInt16BE(0);
                head = dbChunk.readUInt8(2);
                idSector = dbChunk.readUInt8(3);
                size = dbChunk.readUInt16BE(4);
                flags = dbChunk.readUInt8(6);
                pattern = dbChunk.readUInt8(7);
                sector = {
                    [DiskImage.SECTOR.CYLINDER]: cylinder,
                    [DiskImage.SECTOR.HEAD]:     head,
                    [DiskImage.SECTOR.ID]:       idSector,
                    [DiskImage.SECTOR.LENGTH]:   size,
                    [DiskImage.SECTOR.DATA]:     []
                };
                sectorIndex = 0;
                maxIndex = size >> 2;
                this.printf(Device.MESSAGE.INFO, "SECT: %d:%d:%d %d bytes, flags 0x%x, pattern 0x%02x\n", cylinder, head, idSector, size, flags, pattern);
                while (data.length < cylinder + 1) {
                    data.push([]);
                }
                while (data[cylinder].length < head + 1) {
                    data[cylinder].push([]);
                }
                data[cylinder][head].push(sector);
                if (flags & 0x1) {
                    sector[DiskImage.SECTOR.DATA][sectorIndex++] = pattern | (pattern << 8) | (pattern << 16) | (pattern << 24);
                }
                if (flags & 0x4) {
                    sector[DiskImage.SECTOR.DATA_ERROR] = -1;
                }
                if (flags & ~(0x1 | 0x4)) {
                    this.printf(Device.MESSAGE.WARN, "unsupported flags: 0x%x\n", flags);
                }
                this.cbDiskData += size;
                break;

            case CHUNK_DATA:
                this.printf(Device.MESSAGE.INFO, "DATA: %d bytes\n", dbChunk.length);
                if (!sector) {
                    this.printf(Device.MESSAGE.ERROR, "no sector defined, aborting\n");
                    chunkID = 0;
                    break;
                }
                if (sectorIndex) {
                    this.printf(Device.MESSAGE.WARN, "warning: sector with data and pattern\n");
                    sectorIndex = 0;
                }
                for (let off = 0; off < dbChunk.length; off += 4) {
                    if (sectorIndex >= maxIndex) {
                        this.printf(Device.MESSAGE.WARN, "warning: data for sector offset %d exceeds sector length\n", sectorIndex * 4, size);
                    }
                    sector[DiskImage.SECTOR.DATA][sectorIndex++] = dbChunk.readUInt8(off) | (dbChunk.readUInt8(off+1) << 8) | (dbChunk.readUInt8(off+2) << 16) | (dbChunk.readUInt8(off+3) << 24);
                }
                if (sectorIndex < maxIndex) {
                    this.printf(Device.MESSAGE.WARN, "warning: sector data stops at offset %d instead of %d\n", sectorIndex * 4, size);
                }
                break;

            case CHUNK_IBMM:
                this.printf(Device.MESSAGE.INFO, "IBMM: at 0x%x\n", chunkOffset);
                break;

            case CHUNK_OFFS:
                this.printf(Device.MESSAGE.INFO, "OFFS: at 0x%x\n", chunkOffset);
                break;

            case CHUNK_TEXT:
                this.printf(Device.MESSAGE.INFO, "TEXT: at 0x%x\n", chunkOffset);
                break;

            case CHUNK_END:
                chunkID = 0;
                this.aDiskData = data;
                break;

            default:
                this.printf(Device.MESSAGE.WARN, "unrecognized chunk at 0x%x: 0x%08x\n", chunkOffset, chunkID);
                chunkID = 0;
            }
            if (!chunkID) break;
        }
        return !!this.aDiskData;
    }

    /**
     * buildFileTableFromJSON(fileTable)
     *
     * Convert an array of JSON FILEDESC objects to FileInfo objects.
     *
     * @this {DiskImage}
     * @param {Array.<Object>} fileTable
     */
    buildFileTableFromJSON(fileTable)
    {
        if (!fileTable) return;
        if (!this.fileTable.length) {
            for (let i = 0; i < fileTable.length; i++) {
                let desc = fileTable[i];
                let iVolume = desc[DiskImage.FILEDESC.VOL] || 0;
                let name = this.device.getBaseName(desc[DiskImage.FILEDESC.PATH]);
                let path = desc[DiskImage.FILEDESC.PATH].replace(/\//g, '\\');
                let attr = +desc[DiskImage.FILEDESC.ATTR];
                let date = this.device.parseDate(desc[DiskImage.FILEDESC.DATE]);
                let size = desc[DiskImage.FILEDESC.SIZE] || 0;
                fileTable[i] = new FileInfo(this, iVolume, path, name, attr, date, size)
                let hash = desc[DiskImage.FILEDESC.HASH];
                if (hash) fileTable[i].hash = hash;
            }
            this.fileTable = fileTable;
        }
    }

    /**
     * buildTables(fRebuild)
     *
     * This function builds (or rebuilds) a complete file table from all FAT volumes found on the current disk,
     * and then updates all the sector objects with references to the corresponding file and offset.  Used for
     * BACKTRACK and SYMBOLS support.  Because this is an expensive operation, in terms of both time and memory,
     * it should only be called when a disk is mounted or has been modified (eg, by applying deltas from a saved
     * machine state).
     *
     * More recently, the FileInfo objects in the table have been enhanced to include debugging information if
     * the file is an EXE or DLL, which we determine merely by checking the file extension.
     *
     * Note that while most of the methods in this module use CHS-style parameters, because our primary clients
     * are old disk controllers that deal exclusively with cylinder/head/sector values, here we use 0-based
     * "volume" sector numbers for volume-relative block addresses (aka VBAs or Volume Block Addresses), and
     * 0-based "logical" sector numbers for disk-relative block addresses (aka LBAs or Logical Block Addresses).
     *
     * TODO: It should be possible to reconstitute these tables from our newer "extended" JSON images, if that
     * was the source of the image.
     *
     * @this {DiskImage}
     * @param {boolean} fRebuild
     * @returns {number}
     */
    buildTables(fRebuild)
    {
        if (!this.fileTable.length || fRebuild) {

            this.deleteTables();

            let sectorBoot = this.getSector(0);
            if (!sectorBoot) {
                this.printf(Device.MESSAGE.DISK + Device.MESSAGE.ERROR, "%s error: unable to read boot sector\n", this.diskName);
                return;
            }

            /*
             * Process all recognized volumes.
             *
             * NOTE: Our file table currently supports only files on FAT volumes, and there is only one file
             * table for all FAT volumes; every FileInfo object contains a volume index to indicate the volume.
             */
            let iVolume = 0;
            while (true) {
                let vol = this.buildVolume(iVolume, sectorBoot);
                if (!vol || vol.iPartition < 0) break;
                iVolume++;
            }

            /*
             * For all files in the file table, create the sector-to-file mappings now.
             */
            for (let iFile = 0; iFile < this.fileTable.length; iFile++) {
                let file = this.fileTable[iFile], off = 0;
                if (file.name == "." || file.name == "..") continue;
                for (let iSector = 0; iSector < file.aLBA.length; iSector++) {
                    this.updateSector(iFile, off, file.aLBA[iSector]);
                    off += this.cbSector;
                }
                file.loadSymbols();
            }
        }
        return this.fileTable.length;
    }

    /**
     * buildVolume(iVolume, sectorBoot)
     *
     * @param {number} iVolume
     * @param {Sector} sectorBoot
     * @returns {VolInfo|null}
     */
    buildVolume(iVolume, sectorBoot)
    {
        let idFAT = 0;
        let cbDisk = this.nCylinders * this.nHeads * this.nSectors * this.cbSector;
        let vol = /** @type {VolInfo} */({iVolume, iPartition: -1, idMedia: 0, lbaStart: 0, lbaTotal: 0});

        if (iVolume == 0) {

            vol.idMedia = this.getSectorData(sectorBoot, DiskImage.BPB.MEDIA_ID, 1);
            vol.cbSector = this.getSectorData(sectorBoot, DiskImage.BPB.SECTOR_BYTES, 2);

            if (vol.cbSector != this.cbSector || !this.checkMediaID(vol.idMedia)) {
                /*
                 * When the first sector doesn't appear to contain a valid BPB, the most likely explanations are:
                 *
                 *      1. The image is from a diskette formatted by DOS 1.x, which didn't use BPBs
                 *      2. The image is a fixed (partitioned) disk and the first sector is actually an MBR
                 *      3. The image is from a diskette that used a non-standard boot sector (or sector size)
                 *
                 * We start by assuming it's a DOS 1.x diskette (or a DOS diskette with a non-standard boot sector),
                 * so we'll check ALL our default (diskette) BPBs.  If the diskette looks like a match (both in terms
                 * of FAT ID and total disk size), then we'll extract the remaining BPB defaults.
                 */
                vol.idMedia = 0;
                vol.vbaFAT = 1;
                vol.nFATBits = 12;
                vol.cbSector == this.cbSector;
                idFAT = this.getClusterEntry(vol, 0, 0);
                for (let i = 0; i < DiskImage.aDefaultBPBs.length; i++) {
                    let bpb = DiskImage.aDefaultBPBs[i];
                    if (bpb[DiskImage.BPB.MEDIA_ID] == idFAT) {
                        let cbDiskBPB = (bpb[DiskImage.BPB.TOTAL_SECS] + (bpb[DiskImage.BPB.TOTAL_SECS + 1] * 0x100)) * this.cbSector;
                        if (cbDiskBPB == cbDisk) {
                            vol.idMedia = idFAT;
                            /*
                             * NOTE: Like TOTAL_SECS, FAT_SECS and ROOT_DIRENTS are 2-byte fields; but unlike TOTAL_SECS,
                             * their upper byte is zero in all our default (diskette) BPBs, so there's no need to fetch them.
                             */
                            vol.vbaRoot = vol.vbaFAT + bpb[DiskImage.BPB.FAT_SECS] * bpb[DiskImage.BPB.TOTAL_FATS];
                            vol.clusSecs = bpb[DiskImage.BPB.CLUSTER_SECS];
                            vol.lbaTotal = cbDiskBPB / this.cbSector;
                            vol.nEntries = bpb[DiskImage.BPB.ROOT_DIRENTS];
                            vol.cbSector = this.cbSector;
                            break;
                        }
                    }
                }
            }
        }

        let iVolFound = 0;
        if (!vol.idMedia) {

            idFAT = 0;
            vol.cbSector = this.cbSector;

            /*
             * So, this is either a fixed (partitioned) disk, or a disk using a non-standard sector size.
             *
             * Let's assume the former (ie, we have an MBR) and check for partition records.  We will do this check
             * in two phases: checking for "primary" partition records first, and for "extended" partition records next.
             */
            let iEntry;
            let maxIterations = 48;     // circuit breaker tripped after 24 potential volumes (with 2 phases per volume)
            let lbaPrimary = 0, lbaExtended = 0;

            for (let iPhase = 0; iPhase <= 1; iPhase++) {

                iEntry = 0;
                while (iEntry < 4) {

                    let lba;
                    let off = DiskImage.MBR.PARTITIONS.OFFSET + iEntry * DiskImage.MBR.PARTITIONS.ENTRY_LENGTH;
                    let bStatus = this.getSectorData(sectorBoot, off + DiskImage.MBR.PARTITIONS.ENTRY.STATUS, 1);

                    if (bStatus == DiskImage.MBR.PARTITIONS.STATUS.ACTIVE || bStatus == DiskImage.MBR.PARTITIONS.STATUS.INACTIVE) {

                        let bType = this.getSectorData(sectorBoot, off + DiskImage.MBR.PARTITIONS.ENTRY.TYPE, 1);

                        if (bType == DiskImage.MBR.PARTITIONS.TYPE.FAT12_PRIMARY || bType == DiskImage.MBR.PARTITIONS.TYPE.FAT16_PRIMARY) {
                            if (iPhase == 0 && iVolFound++ == iVolume) {
                                lba = this.getSectorData(sectorBoot, off + DiskImage.MBR.PARTITIONS.ENTRY.VBA_FIRST, 4);
                                vol.lbaStart = lba + lbaPrimary;
                                sectorBoot = this.getSector(vol.lbaStart);
                                if (!sectorBoot) break;     // something's wrong
                                if (this.getSectorData(sectorBoot, DiskImage.BPB.SECTOR_BYTES, 2) != this.cbSector) {
                                    sectorBoot = null;      // sectorBoot should have contained a DOS boot sector with BPB, but apparently not
                                }
                                break;
                            }
                        }
                        if (bType == DiskImage.MBR.PARTITIONS.TYPE.EXTENDED) {
                            if (iPhase == 1) {
                                lba = this.getSectorData(sectorBoot, off + DiskImage.MBR.PARTITIONS.ENTRY.VBA_FIRST, 4);
                                lbaPrimary = lba + lbaExtended;
                                if (!lbaExtended) lbaExtended = lbaPrimary;
                                sectorBoot = this.getSector(lbaPrimary);
                                if (!sectorBoot) break;     // something's wrong
                                iEntry = iPhase = 0;        // sectorBoot should contain another (extended) boot record table
                                continue;
                            }
                        }
                    }
                    iEntry++;
                }
                if (iEntry < 4 || !--maxIterations) break;
            }

            if (!sectorBoot || iEntry == 4) {
                if (!iVolume) this.printf(Device.MESSAGE.DISK + Device.MESSAGE.WARN, "%s warning: %d-byte disk image contains unknown volume(s)\n", this.diskName, cbDisk);
                return null;
            }

            vol.sectorFATCache = null;  // since vol.lbsStart may have changed, these cache variables must be flushed as well
        }

        vol.iPartition = iVolFound - 1;

        if (!vol.lbaTotal) {
            vol.idMedia = this.getSectorData(sectorBoot, DiskImage.BPB.MEDIA_ID, 1);
            vol.lbaTotal = this.getSectorData(sectorBoot, DiskImage.BPB.TOTAL_SECS, 2) || this.getSectorData(sectorBoot, DiskImage.BPB.LARGE_SECS, 4);
            vol.vbaFAT = this.getSectorData(sectorBoot, DiskImage.BPB.RESERVED_SECS, 2);
            vol.vbaRoot = vol.vbaFAT + this.getSectorData(sectorBoot, DiskImage.BPB.FAT_SECS, 2) * this.getSectorData(sectorBoot, DiskImage.BPB.TOTAL_FATS, 1);
            vol.nEntries = this.getSectorData(sectorBoot, DiskImage.BPB.ROOT_DIRENTS, 2);
            vol.clusSecs = this.getSectorData(sectorBoot, DiskImage.BPB.CLUSTER_SECS, 1);
        }

        vol.vbaData = vol.vbaRoot + (((vol.nEntries * DiskImage.DIRENT.LENGTH + (vol.cbSector - 1)) / vol.cbSector) | 0);
        vol.clusTotal = (((vol.lbaTotal - vol.vbaData) / vol.clusSecs) | 0);

        /*
         * In all FATs, the first valid cluster number is 2, as 0 is used to indicate a free cluster and 1 is reserved.
         *
         * In a 12-bit FAT chain, the largest valid cluster number (clusMax) is 0xFF6; 0xFF7 is reserved for marking
         * bad clusters and should NEVER appear in a cluster chain, and 0xFF8-0xFFF are used to indicate the end of a chain.
         * Reports that cluster numbers 0xFF0-0xFF6 are "reserved" (eg, http://support.microsoft.com/KB/65541) should be
         * ignored; those numbers may have been considered "reserved" at some early point in FAT's history, but no longer.
         *
         * Since 12 bits yield 4096 possible values, and since 11 of the values (0, 1, and 0xFF7-0xFFF) cannot be used to
         * refer to an actual cluster, that leaves a theoretical maximum of 4085 clusters for a 12-bit FAT.  However, for
         * reasons that only a small (and shrinking -- RIP AAR) number of people know, the actual cut-off is 4084.
         *
         * So, a FAT volume with 4084 or fewer clusters uses a 12-bit FAT, a FAT volume with 4085 to 65524 clusters uses
         * a 16-bit FAT, and a FAT volume with more than 65524 clusters uses a 32-bit FAT.
         *
         * TODO: Eventually add support for FAT32.
         */
        vol.nFATBits = (vol.clusTotal <= DiskImage.FAT12.MAX_CLUSTERS? 12 : 16);
        vol.clusMax = (vol.nFATBits == 12? DiskImage.FAT12.CLUSNUM_MAX : DiskImage.FAT16.CLUSNUM_MAX);

        if (!idFAT) idFAT = this.getClusterEntry(vol, 0, 0);

        if (idFAT != vol.idMedia) {
            this.printf(Device.MESSAGE.DISK + Device.MESSAGE.ERROR, "%s volume %d error: FAT ID (%#0bx) does not match media ID (%#0bx)\n", this.diskName, iVolume, idFAT, vol.idMedia);
            return null;
        }

        if (Device.DEBUG) this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%s:\n  vbaFAT: %d\n  vbaRoot: %d\n  vbaData: %d\n  lbaTotal: %d\n  clusSecs: %d\n  clusTotal: %d\n", this.diskName, vol.vbaFAT, vol.vbaRoot, vol.vbaData, vol.lbaTotal, vol.clusSecs, vol.clusTotal);

        /*
         * The following assertion is here only to catch anomalies; it is NOT a requirement that the number of data sectors
         * be a perfect multiple of clusSecs, but if it ever happens, it's worth verifying we didn't miscalculate something.
         */
        let nWasted = (vol.lbaTotal - vol.vbaData) % vol.clusSecs;
        if (nWasted) this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%s volume %d contains %d sectors, wasting %d sectors\n", this.diskName, iVolume, vol.lbaTotal, nWasted);

        /*
         * Similarly, it is NOT a requirement that the size of all root directory entries be a perfect multiple of the sector
         * size (cbSector), but it may indicate a problem if it's not.  Note that when it comes time to read the root directory,
         * we treat it exactly like any other directory; that is, we ignore the nEntries value and scan the entire contents of
         * every sector allocated to the directory.  TODO: Determine whether DOS reads all root sector contents or only nEntries
         * (ie, create a test volume where nEntries * 32 is NOT a multiple of cbSector and watch what happens).
         */
        this.assert(!((vol.nEntries * DiskImage.DIRENT.LENGTH) % vol.cbSector));

        this.volTable.push(vol);

        let aLBA = [];
        for (let vba = vol.vbaRoot; vba < vol.vbaData; vba++) aLBA.push(vol.lbaStart + vba);
        this.getDir(vol, aLBA);

        /*
         * Calculate free (unused) space, as well as total "bad" space.
         *
         * Some disks, like FLICKERFREE.img, mark all their unused clusters as bad, perhaps to discourage anyone
         * from writing to the disk.  Here's what CHKDSK reports for the FLICKERFREE diskette:
         *
         *      Volume FlickerFree created Apr 1, 1986 12:00a
         *
         *         179712 bytes total disk space
         *              0 bytes in 1 hidden files
         *          48128 bytes in 5 user files
         *         131584 bytes in bad sectors
         *              0 bytes available on disk
         *
         *         262144 bytes total memory
         *         237568 bytes free
         *
         * And it's a bit of misnomer to list the total as "bad sectors", because the unit of "badness" is a cluster,
         * not a sector, and while for floppies, it's usually true that a cluster is the same size as a sector, that's
         * not true in general.
         */
        vol.clusBad = 0, vol.clusFree = 0;
        for (let cluster = 2; cluster < vol.clusTotal + 2; cluster++) {
            let clusterNext = this.getClusterEntry(vol, cluster, 0) | this.getClusterEntry(vol, cluster, 1);
            if (!clusterNext) {
                vol.clusFree++;
            } else if (clusterNext == vol.clusMax + 1) {
                vol.clusBad++;
            }
        }

        this.printf(Device.MESSAGE.DISK + Device.MESSAGE.INFO, "%s volume %d: %d cluster(s) bad, %d cluster(s) free, %d bytes free\n", this.diskName, iVolume, vol.clusBad, vol.clusFree, vol.clusFree * vol.clusSecs * vol.cbSector);
        return vol;
    }

    /**
     * checkMediaID(idMedia)
     *
     * @this {DiskImage}
     * @param {number} idMedia
     * @returns {boolean} (true if idMedia is valid, false if not)
     */
    checkMediaID(idMedia)
    {
        for (let type in DiskImage.FAT) {
            if (idMedia == DiskImage.FAT[type]) return true;
        }
        return false;
    }

    /**
     * deleteTables()
     *
     * In order for buildTables() to rebuild an existing table (eg, after deltas have been
     * applied), we also need to zap any and all existing file table references in the sector data.
     *
     * @this {DiskImage}
     */
    deleteTables()
    {
        if (this.fileTable.length) {
            let aDiskData = this.aDiskData;
            for (let iCylinder = 0; iCylinder < aDiskData.length; iCylinder++) {
                for (let iHead = 0; iHead < aDiskData[iCylinder].length; iHead++) {
                    for (let iSector = 0; iSector < aDiskData[iCylinder][iHead].length; iSector++) {
                        let sector = aDiskData[iCylinder][iHead][iSector];
                        if (sector) {
                            delete sector[DiskImage.SECTOR.FILE_INFO];
                            delete sector[DiskImage.SECTOR.FILE_OFFSET];
                            delete sector.iModify;
                            delete sector.cModify;
                        }
                    }
                }
            }
        }
        this.fileTable = [];
        this.volTable = [];
    }

    /**
     * getFileListing(iVolume, indent)
     *
     * @this {DiskImage}
     * @param {number} [iVolume] (-1 to list contents of ALL volumes in image)
     * @param {number} [indent]
     * @returns {string}
     */
    getFileListing(iVolume = -1, indent = 0)
    {
        let sListing = "";
        if (this.buildTables()) {
            let nVolumes = this.volTable.length;
            if (iVolume < 0) {
                iVolume = 0;
            } else {
                nVolumes = 1;
            }
            let sIndent = " ".repeat(indent);
            while (iVolume < this.volTable.length && nVolumes-- > 0) {
                let vol = this.volTable[iVolume];
                let curVol = -1;
                let curDir = null;
                let cbDir = 0, nFiles = 0;
                let cbTotal = 0, nTotal = 0;
                let getTotal = function(nFiles, cbDir) {
                    return this.device.sprintf("%s %8d file(s)   %8d bytes\n", sIndent, nFiles, cbDir);
                }.bind(this);
                let i, sLabel = "", sDrive = "?";
                for (i = 0; i < this.fileTable.length; i++) {
                    let file = this.fileTable[i];
                    if (file.iVolume != iVolume) continue;
                    if (file.path.lastIndexOf('\\') > 0) break;     // don't look beyond the root directory for a volume label
                    if (file.attr & DiskImage.ATTR.VOLUME) {
                        sLabel = file.name.replace(".", "");
                        break;
                    }
                }
                for (i = 0; i < this.fileTable.length; i++) {
                    let file = this.fileTable[i];
                    if (file.iVolume != iVolume) continue;
                    if (file.attr & DiskImage.ATTR.VOLUME) continue;
                    if (curVol != file.iVolume) {
                        let vol = this.volTable[file.iVolume];
                        sDrive = String.fromCharCode(vol.iPartition < 0? 0x41 : 0x43 + vol.iPartition);
                        curVol = file.iVolume;
                    }
                    let name = file.name;
                    let j = file.path.lastIndexOf('\\');
                    let dir = file.path.substring(0, j);
                    if (!dir) dir = "\\";
                    let ext = "";
                    if (name[0] != '.') {
                        j = name.indexOf(".");
                        if (j >= 0) {
                            ext = name.substr(j + 1);
                            name = name.substr(0, j);
                        }
                    }
                    if (curDir != dir) {
                        if (curDir != null) {
                            sListing += getTotal(nFiles, cbDir);
                        } else {
                            sListing += this.device.sprintf("\n%s Volume in drive %s %s%s", sIndent, sDrive, sLabel? "is " : "has no label", sLabel);
                        }
                        curDir = dir;
                        sListing += this.device.sprintf("\n%s Directory of %s:%s\n\n", sIndent, sDrive, dir);
                        cbDir = nFiles = 0;
                    }
                    let sSize;
                    if (file.attr & DiskImage.ATTR.SUBDIR) {
                        sSize = "<DIR>    ";
                    } else {
                        sSize = this.device.sprintf("%9d", file.size);
                        cbDir += file.size;
                        cbTotal += file.size;
                    }
                    sListing += this.device.sprintf("%s%-8s %-3s%s%s  %#2M-%#02D-%#0.2Y  %#2I:%#02N%#.1A\n", sIndent, name, ext, (file.attr & (DiskImage.ATTR.READONLY | DiskImage.ATTR.HIDDEN | DiskImage.ATTR.SYSTEM))? "*" : " ", sSize, file.date);
                    nTotal++;
                    /*
                     * NOTE: While it seems odd to include all SUBDIR entries in the file count, that's what DOS always did, so we do, too.
                     * SUBDIRs don't affect the current directory's byte total (cbDir), since A) the size of a SUBDIR entry is normally recorded
                     * as zero (regardless whether the SUBDIR contains files or not), and B) we don't add their size to the total anyway.
                     */
                    nFiles++;
                }
                sListing += getTotal(nFiles, cbDir);
                if (nTotal > nFiles) {
                    sListing += "\n" + sIndent + "Total files listed:\n";
                    sListing += getTotal(nTotal, cbTotal);
                }
                /*
                 * This calculation used to use vol.cbSector, but we don't really support volumes with (default) sector sizes that
                 * that differ from the disk's (default) sector size, nor do we export per-volume sector sizes in the VOLDESC structure,
                 * so the only code that can rely on vol.cbSector is buildTables(), buildVolume(), and any other code that follows
                 * those calls -- and if we've reconstituted the disk and all its tables using buildDiskFromJSON(), that doesn't happen
                 * automatically.
                 */
                sListing += this.device.sprintf("%s%28d bytes free\n", sIndent, vol.clusFree * vol.clusSecs * this.cbSector);
                iVolume++;
            }
        }
        return sListing;
    }

    /**
     * getFileDesc(file, fComplete, fnHash)
     *
     * @this {DiskImage}
     * @param {FileInfo} file
     * @param {boolean} [fComplete] (if not "complete", then the descriptor omits NAME, since PATH includes it, as well as SIZE and VOL when they are zero)
     * @param {function(Array,string)} [fnHash]
     * @returns {Object}
     */
    getFileDesc(file, fComplete, fnHash)
    {
        let desc = {
            [DiskImage.FILEDESC.HASH]: file.hash,
            [DiskImage.FILEDESC.PATH]: file.path.replace(/\\/g, '/'),
            [DiskImage.FILEDESC.NAME]: file.name,
            [DiskImage.FILEDESC.ATTR]: this.device.sprintf("%#0bx", file.attr),
            [DiskImage.FILEDESC.DATE]: this.device.sprintf("%#T", file.date),
            [DiskImage.FILEDESC.SIZE]: file.size,
            [DiskImage.FILEDESC.VOL]:  file.iVolume
        };
        if (!fComplete) {
            delete desc[DiskImage.FILEDESC.NAME];
            if (!file.size && (file.attr & DiskImage.ATTR.SUBDIR | DiskImage.ATTR.VOLUME)) {
                delete desc[DiskImage.FILEDESC.SIZE];
            }
            if (!file.iVolume) {
                delete desc[DiskImage.FILEDESC.VOL];
            }
        }
        if (file.module) {
            desc[DiskImage.FILEDESC.MODULE] = {
                [DiskImage.FILEDESC.MODNAME]: file.module,
                [DiskImage.FILEDESC.MODDESC]: file.modDesc,
                [DiskImage.FILEDESC.MODSEGS]: file.segments
            }
        }
        if (fnHash && file.size) {
            let ab = new Array(file.size);
            this.readSectorArray(ab, file.aLBA);
            desc[DiskImage.FILEDESC.HASH] = fnHash(ab);
        } else {
            if (!desc[DiskImage.FILEDESC.HASH]) delete desc[DiskImage.FILEDESC.HASH];
        }
        return desc;
    }

    /**
     * getVolDesc(vol, fComplete)
     *
     * @this {DiskImage}
     * @param {VolInfo} vol
     * @param {boolean} [fComplete] (currently, all descriptors are "complete")
     * @returns {Object}
     */
    getVolDesc(vol, fComplete)
    {
        let desc = {
            [DiskImage.VOLDESC.MEDIA_ID]:   vol.idMedia,
            [DiskImage.VOLDESC.LBA_VOL]:    vol.lbaStart,
            [DiskImage.VOLDESC.LBA_TOTAL]:  vol.lbaTotal,
            [DiskImage.VOLDESC.FAT_ID]:     vol.nFATBits,
            [DiskImage.VOLDESC.VBA_FAT]:    vol.vbaFAT,
            [DiskImage.VOLDESC.VBA_ROOT]:   vol.vbaRoot,
            [DiskImage.VOLDESC.ROOT_TOTAL]: vol.nEntries,
            [DiskImage.VOLDESC.VBA_DATA]:   vol.vbaData,
            [DiskImage.VOLDESC.CLUS_SECS]:  vol.clusSecs,
            [DiskImage.VOLDESC.CLUS_MAX]:   vol.clusMax,
            [DiskImage.VOLDESC.CLUS_BAD]:   vol.clusBad,
            [DiskImage.VOLDESC.CLUS_FREE]:  vol.clusFree,
            [DiskImage.VOLDESC.CLUS_TOTAL]: vol.clusTotal
        };
        return desc;
    }

    /**
     * getFileManifest(fnHash)
     *
     * Returns an array of FILEDESC (file descriptors).  Each object is largely a clone
     * of the FileInfo object, with the exception of cluster and aLBA properties (which aren't
     * useful outside the context of the DiskImage object), and with the inclusion of
     * a HASH property, if the caller provides a hash function.
     *
     * @this {DiskImage}
     * @param {function(Array,string)} [fnHash]
     * @returns {Array}
     */
    getFileManifest(fnHash)
    {
        let aFiles = [];
        if (this.buildTables()) {
            for (let i = 0; i < this.fileTable.length; i++) {
                let file = this.fileTable[i];
                if (file.name == "." || file.name == "..") continue;
                aFiles.push(this.getFileDesc(file, true, fnHash));
            }
        }
        return aFiles;
    }

    /**
     * getModuleInfo(sModule, nSegment)
     *
     * If the given module and segment number is found, we return an Array of symbol offsets, indexed by symbol name.
     *
     * @this {DiskImage}
     * @param {string} sModule
     * @param {number} nSegment
     * @returns {Object}
     */
    getModuleInfo(sModule, nSegment)
    {
        let aSymbols = {};
        for (let iFile = 0; iFile < this.fileTable.length; iFile++) {
            let file = this.fileTable[iFile];
            if (file.sModule != sModule) continue;
            let segment = file.aSegments[nSegment];
            if (!segment) continue;
            for (let iOrdinal in segment.entries) {
                let entry = segment.entries[iOrdinal];
                /*
                 * entry[1] is the symbol name, which becomes the index, and entry[0] is the offset.
                 */
                aSymbols[entry[1]] = entry[0];
            }
            break;
        }
        return aSymbols;
    }

    /**
     * getSymbolInfo(sSymbol)
     *
     * For all whole or partial symbol matches, return them in an Array of entries:
     *
     *      [symbol, file name, segment number, segment offset, segment size].
     *
     * TODO: This function has many limitations (ie, slow, case-sensitive), but it gets the job done for now.
     *
     * @this {DiskImage}
     * @param {string} sSymbol
     * @returns {Array}
     */
    getSymbolInfo(sSymbol)
    {
        let aInfo = [];
        let sSymbolUpper = sSymbol.toUpperCase();
        for (let iFile = 0; iFile < this.fileTable.length; iFile++) {
            let file = this.fileTable[iFile];
            for (let iSegment in file.aSegments) {
                let segment = file.aSegments[iSegment];
                for (let iOrdinal in segment.entries) {
                    let entry = segment.entries[iOrdinal];
                    if (entry[1] && entry[1].indexOf(sSymbolUpper) >= 0) {
                        aInfo.push([entry[1], file.name, iSegment, entry[0], segment.offEnd - segment.offStart]);
                    }
                }
            }
        }
        return aInfo;
    }

    /**
     * getDate(year, month, day, hour, minute, second, sFile)
     *
     * @this {DiskImage}
     * @param {number} year
     * @param {number} month
     * @param {number} day
     * @param {number} hour
     * @param {number} minute
     * @param {number} second
     * @param {number} sFile
     * @returns {Date} (UTC date corresponding to the given date/time parameters)
     */
    getDate(year, month, day, hour, minute, second, sFile)
    {
        let errors = 0;
        let y = year, m = month, d = day, h = hour, n = minute, s = second;
        if (m > 11) {
            m = 11;
            errors++;
        }
        if (d > 31) {
            d = 31;
            errors++;
        }
        if (h > 23) {
            h = 23;
            errors++;
        }
        if (n > 59) {
            n = 59;
            errors++;
        }
        if (s > 59) {
            s = 59;
            errors++;
        }
        if (errors) {
            this.printf(Device.MESSAGE.DISK + Device.MESSAGE.WARN, "%s warning: invalid timestamp: %04d-%02d-%02d %02d:%02d:%02d\n", sFile, year, month, day, hour, minute, second);
        }
        return this.device.parseDate(y, m, d, h, n, s);
    }

    /**
     * getDir(vol, aLBA, dir, path)
     *
     * @this {DiskImage}
     * @param {VolInfo} vol
     * @param {Array.<number>} aLBA
     * @param {DirInfo} [dir]
     * @param {string} [path]
     */
    getDir(vol, aLBA, dir = {}, path = "")
    {
        let file;
        let iStart = this.fileTable.length;
        let nEntriesPerSector = (vol.cbSector / DiskImage.DIRENT.LENGTH) | 0;

        dir.path = path + "\\";

        if (Device.DEBUG) this.printf(Device.MESSAGE.DISK, 'getDir("%s","%s")\n', this.diskName, dir.path);

        for (let iSector = 0; iSector < aLBA.length; iSector++) {
            let lba = aLBA[iSector];
            for (let iEntry = 0; iEntry < nEntriesPerSector; iEntry++) {
                if (!this.getDirEntry(vol, dir, lba, iEntry)) {
                    iSector = aLBA.length;
                    break;
                }
                if (dir.name == null) continue;
                let path = dir.path + dir.name;
                let dateMod = this.getDate(
                    (dir.modDate >> 9) + 1980,
                    ((dir.modDate >> 5) & 0xf) - 1,
                    (dir.modDate & 0x1f),
                    (dir.modTime >> 11),
                    (dir.modTime >> 5) & 0x3f,
                    (dir.modTime & 0x1f) << 1,
                    this.diskName + ":" + path
                );
                file = new FileInfo(this, vol.iVolume, path, dir.name, dir.attr, dateMod, dir.size, dir.cluster, dir.aLBA);
                this.fileTable.push(file);
            }
        }

        let iEnd = this.fileTable.length;

        for (let i = iStart; i < iEnd; i++) {
            file = this.fileTable[i];
            if ((file.attr & DiskImage.ATTR.SUBDIR) && file.aLBA.length && file.name != "." && file.name != "..") {
                this.getDir(vol, file.aLBA, dir, path + "\\" + file.name);
            }
        }
    }

    /**
     * getDirEntry(vol, dir, lba, i)
     *
     * This sets the following properties on the 'dir' object:
     *
     *      sName (null if invalid/deleted entry)
     *      attr
     *      size
     *      cluster
     *      aLBA (ie, array of physical block addresses)
     *
     * On return, it's the caller's responsibility to copy out any data into a new object
     * if it wants to preserve any of the above information.
     *
     * This function also caches the following properties in the 'dir' object:
     *
     *      lbaDirCache (of the last directory sector read, if any)
     *      sectorDirCache (of the last directory sector read, if any)
     *
     * Also, the caller must also set the following 'dir' helper properties, so that clusters
     * can be located and converted to sectors (see convertClusterToSectors):
     *
     *      vbaFAT
     *      vbaData
     *      cbSector
     *      clusMax
     *      clusSecs
     *      nFATBits
     *
     * @this {DiskImage}
     * @param {VolInfo} vol
     * @param {DirInfo} dir (to be filled in)
     * @param {number} lba (a sector of the directory)
     * @param {number} i (an entry in the directory sector, 0-based)
     * @returns {boolean} true if entry was returned (even if invalid/deleted), false if no more entries
     */
    getDirEntry(vol, dir, lba, i)
    {
        if (!vol.sectorDirCache || !vol.lbaDirCache || vol.lbaDirCache != lba) {
            vol.lbaDirCache = lba;
            vol.sectorDirCache = this.getSector(vol.lbaDirCache);
            // if (Device.DEBUG) this.printf(Device.MESSAGE.DISK, this.dumpSector(vol.sectorDirCache, vol.lbaDirCache, dir.path));
        }
        if (vol.sectorDirCache) {
            let off = i * DiskImage.DIRENT.LENGTH;
            let b = this.getSectorData(vol.sectorDirCache, off, 1);
            if (b == DiskImage.DIRENT.UNUSED) {
                return false;
            }
            if (b == DiskImage.DIRENT.INVALID) {
                dir.name = null;
                return true;
            }
            dir.name = this.getSectorString(vol.sectorDirCache, off + DiskImage.DIRENT.NAME, 8).trim();
            let s = this.getSectorString(vol.sectorDirCache, off + DiskImage.DIRENT.EXT, 3).trim();
            if (s.length) dir.name += '.' + s;
            dir.attr = this.getSectorData(vol.sectorDirCache, off + DiskImage.DIRENT.ATTR, 1);
            dir.modDate = this.getSectorData(vol.sectorDirCache, off + DiskImage.DIRENT.MODDATE, 2);
            dir.modTime = this.getSectorData(vol.sectorDirCache, off + DiskImage.DIRENT.MODTIME, 2);
            dir.size = this.getSectorData(vol.sectorDirCache, off + DiskImage.DIRENT.SIZE, 4);
            if (dir.size < 0) {
                dir.size = 0;
            }
            dir.cluster = this.getSectorData(vol.sectorDirCache, off + DiskImage.DIRENT.CLUSTER, 2);
            dir.aLBA = this.convertClusterToSectors(vol, dir);
            return true;
        }
        return false;
    }

    /**
     * convertClusterToSectors(vol, dir)
     *
     * @this {DiskImage}
     * @param {VolInfo} vol
     * @param {DirInfo} dir
     * @returns {Array.<number>} of LBAs (physical block addresses)
     */
    convertClusterToSectors(vol, dir)
    {
        let aLBA = [];
        let cluster = dir.cluster;
        if (cluster) {
            do {
                if (cluster < DiskImage.FAT12.CLUSNUM_MIN) {
                    break;
                }
                let vba = vol.vbaData + ((cluster - DiskImage.FAT12.CLUSNUM_MIN) * vol.clusSecs);
                for (let i = 0; i < vol.clusSecs; i++) {
                    aLBA.push(vol.lbaStart + vba++);
                }
                cluster = this.getClusterEntry(vol, cluster, 0) | this.getClusterEntry(vol, cluster, 1);
            } while (cluster <= vol.clusMax);

            if (cluster < DiskImage.FAT12.CLUSNUM_MIN || cluster == vol.clusMax + 1 /* aka CLUSNUM_BAD */) {
                this.printf(Device.MESSAGE.DISK + Device.MESSAGE.WARN, "%s warning: %s contains invalid cluster (%d)\n", this.diskName, dir.name, cluster);
            }
        }
        return aLBA;
    }

    /**
     * getClusterEntry(vol, cluster, iByte)
     *
     * @this {DiskImage}
     * @param {VolInfo} vol
     * @param {number} cluster
     * @param {number} iByte (0 for low byte of cluster entry, 1 for high byte)
     * @returns {number}
     */
    getClusterEntry(vol, cluster, iByte)
    {
        let w = 0;
        let cbitsSector = vol.cbSector * 8;
        let offBits = vol.nFATBits * cluster + (iByte? 8 : 0);
        let iSector = (offBits / cbitsSector) | 0;
        if (!vol.sectorFATCache || !vol.vbaFATCache || vol.vbaFATCache != vol.vbaFAT + iSector) {
            vol.vbaFATCache = vol.vbaFAT + iSector;
            vol.sectorFATCache = this.getSector(vol.lbaStart + vol.vbaFATCache);
        }
        if (vol.sectorFATCache) {
            offBits = (offBits % cbitsSector) | 0;
            let off = (offBits >> 3);
            w = this.getSectorData(vol.sectorFATCache, off, 1);
            if (!iByte) {
                if (offBits & 0x7) w >>= 4;
            } else {
                if (vol.nFATBits == 16) {
                    w <<= 8;
                } else {
                    this.assert(vol.nFATBits == 12);
                    if (offBits & 0x7) {
                        w <<= 4;
                    } else {
                        w = (w & 0xf) << 8;
                    }
                }
            }
        }
        return w;
    }

    /**
     * getSector(lba)
     *
     * @this {DiskImage}
     * @param {number} lba (physical block address)
     * @returns {Sector|null} sector
     */
    getSector(lba)
    {
        let nSectorsPerCylinder = this.nHeads * this.nSectors;
        let iCylinder = (lba / nSectorsPerCylinder) | 0;
        if (iCylinder < this.nCylinders) {
            let nSectorsRemaining = (lba % nSectorsPerCylinder);
            let iHead = (nSectorsRemaining / this.nSectors) | 0;
            /*
             * LBA numbers are 0-based, but the sector numbers in CHS addressing are 1-based, so add one to iSector
             */
            let iSector = (nSectorsRemaining % this.nSectors) + 1;
            return this.seek(iCylinder, iHead, iSector);
        }
        return null;
    }

    /**
     * readSectorArray(ab, aLBA)
     *
     * @this {DiskImage}
     * @param {Array.<number>} ab
     * @param {Array.<number>} aLBA
     * @returns {number} (number of bytes read)
     */
    readSectorArray(ab, aLBA)
    {
        let iLBA = 0, ib = 0;
        let cbRemain = ab.length;
        while (cbRemain > 0 && iLBA >= 0 && iLBA < aLBA.length) {
            let sector = this.getSector(aLBA[iLBA++]);
            if (!sector) break;
            let cbSector = sector[DiskImage.SECTOR.LENGTH];
            let cbRead = cbRemain > cbSector? cbSector : cbRemain;
            for (let i = 0; i < cbRead; i++) {
                let b = this.read(sector, i);
                if (b < 0) {
                    iLBA = -1;
                    break;
                }
                ab[ib++] = b;
                cbRemain--;
            }
        }
        return ab.length - cbRemain;
    }

    /**
     * getSectorData(sector, off, len)
     *
     * WARNING: This function is restricted to reading data contained ENTIRELY within the specified sector.
     *
     * NOTE: Yes, this function is not the most efficient way to read a byte/word/dword value from within a sector,
     * but given the different states a sector may be in, it's certainly the simplest and safest, and since this is
     * only used by buildTables() and its progeny, it's not clear that we need to be superfast anyway.
     *
     * @this {DiskImage}
     * @param {Sector} sector
     * @param {number} off (byte offset)
     * @param {number} len (1 to 4 bytes)
     * @returns {number}
     */
    getSectorData(sector, off, len)
    {
        let dw = 0;
        let nShift = 0;
        this.assert(len > 0 && len <= 4);
        while (len--) {
            this.assert(off < sector[DiskImage.SECTOR.LENGTH]);
            let b = this.read(sector, off++);
            this.assert(b >= 0);
            if (b < 0) break;
            dw |= (b << nShift);
            nShift += 8;
        }
        return dw;
    }

    /**
     * getSectorString(sector, off, len)
     *
     * WARNING: This function is restricted to reading a string contained ENTIRELY within the specified sector.
     *
     * @this {DiskImage}
     * @param {Sector} sector
     * @param {number} off (byte offset)
     * @param {number} len (use -1 to read a null-terminated string)
     * @returns {string}
     */
    getSectorString(sector, off, len)
    {
        let s = "";
        while (len--) {
            let b = this.read(sector, off++);
            if (b <= 0) break;
            s += String.fromCharCode(b);
        }
        return s;
    }

    /**
     * updateSector(iFile, off, lba)
     *
     * Like getSector(), this must convert a LBA into CHS values; consider factoring that conversion code out.
     *
     * @this {DiskImage}
     * @param {number} iFile
     * @param {number} off (file offset corresponding to the given LBA of the given file)
     * @param {number} lba (physical block address from the file's aLBA)
     * @returns {boolean} true if successfully updated, false if not
     */
    updateSector(iFile, off, lba)
    {
        let nSectorsPerCylinder = this.nHeads * this.nSectors;
        let iCylinder = (lba / nSectorsPerCylinder) | 0;
        let nSectorsRemaining = (lba % nSectorsPerCylinder);
        let iHead = (nSectorsRemaining / this.nSectors) | 0;
        let iSector = (nSectorsRemaining % this.nSectors);
        let cylinder, head, sector;
        if ((cylinder = this.aDiskData[iCylinder]) && (head = cylinder[iHead]) && (sector = head[iSector])) {
            let file = this.fileTable[iFile];
            if (sector[DiskImage.SECTOR.ID] != iSector + 1) {
                this.printf(Device.MESSAGE.DISK + Device.MESSAGE.WARN, "warning: %d:%d:%d has non-standard sector ID %d; see file %s\n", iCylinder, iHead, iSector + 1, sector[DiskImage.SECTOR.ID], file.path);
            }
            if (sector[DiskImage.SECTOR.FILE_INFO] != undefined) {
                let filePrev = this.fileTable[sector[DiskImage.SECTOR.FILE_INFO]];
                this.printf(Device.MESSAGE.DISK + Device.MESSAGE.WARN, 'warning: "%s" cross-linked at offset %d with "%s" at offset %d\n', filePrev.path, sector[DiskImage.SECTOR.FILE_OFFSET], file.path, off);
                return false;
            }
            sector[DiskImage.SECTOR.FILE_INFO] = iFile;
            sector[DiskImage.SECTOR.FILE_OFFSET] = off;
            return true;
        }
        this.printf(Device.MESSAGE.DISK + Device.MESSAGE.ERROR, "%s error: unable to map LBA %d to CHS\n", this.diskName, lba);
        return false;
    }

    /**
     * buildSector(iCylinder, iHead, idSector, cbSector, db, ib)
     *
     * Builds a Sector object with the following properties (see DiskImage.SECTOR for complete list):
     *
     *      Property    Description                     Deprecated
     *      'c':        cylinder number (0-based)       ('cylinder')
     *      'h':        head number (0-based)           ('head')
     *      's':        sector ID                       ('sector')
     *      'l':        size of the sector, in bytes    ('length')
     *      'd':        array of dwords                 ('data')
     *
     * NOTE: The 'pattern' property is no longer used; if the sector ends with a repeated 32-bit pattern,
     * we now store that pattern as the last 'd' (data) array value and shrink the array.
     *
     * @this {DiskImage}
     * @param {number} iCylinder
     * @param {number} iHead
     * @param {number} idSector
     * @param {number} cbSector
     * @param {DataBuffer} [db]
     * @param {number} [ib]
     * @returns {Sector}
     */
    buildSector(iCylinder, iHead, idSector, cbSector, db, ib = 0)
    {
        let adw = [];
        let cdw = cbSector >> 2;
        for (let idw = 0; idw < cdw; idw++, ib += 4) {
            adw[idw] = db && ib < db.length? db.readInt32LE(ib) : 0;
        }
        let sector = /** @type {Sector} */ ({
            [DiskImage.SECTOR.CYLINDER]: iCylinder,
            [DiskImage.SECTOR.HEAD]:     iHead,
            [DiskImage.SECTOR.ID]:       idSector,
            [DiskImage.SECTOR.LENGTH]:   cbSector,
            [DiskImage.SECTOR.DATA]:     adw
        });
        return this.initSector(sector, adw, cbSector, 0);
    }

    /**
     * rebuildSector(iCylinder, iHead, sector)
     *
     * Builds a Sector object with the following properties (see DiskImage.SECTOR for complete list):
     *
     *      Property    Description                     Deprecated
     *      'c':        cylinder number (0-based)       ('cylinder')
     *      'h':        head number (0-based)           ('head')
     *      's':        sector ID                       ('sector')
     *      'l':        size of the sector, in bytes    ('length')
     *      'd':        array of dwords                 ('data')
     *
     * NOTE: The 'pattern' property is no longer used; if the sector ends with a repeated 32-bit pattern,
     * we now store that pattern as the last 'd' array value and shrink the array.
     *
     * @this {DiskImage}
     * @param {number} iCylinder
     * @param {number} iHead
     * @param {Object} sector
     * @returns {Sector}
     */
    rebuildSector(iCylinder, iHead, sector)
    {
        if (sector[DiskImage.SECTOR.CYLINDER] != undefined) {
            this.assert(sector[DiskImage.SECTOR.CYLINDER] == iCylinder);
            delete sector[DiskImage.SECTOR.CYLINDER];
        }

        if (sector[DiskImage.SECTOR.HEAD] != undefined) {
            this.assert(sector[DiskImage.SECTOR.HEAD] == iHead);
            delete sector[DiskImage.SECTOR.HEAD];
        }

        let dwPattern;
        let idSector = sector[DiskImage.SECTOR.ID];
        if (idSector != undefined) {
            delete sector[DiskImage.SECTOR.ID];
        } else {
            idSector = sector['sector'];
            delete sector['sector'];
            dwPattern = sector['pattern'] || 0;
            delete sector['pattern'];
        }

        let cbSector = sector[DiskImage.SECTOR.LENGTH];
        if (cbSector != undefined) {
            delete sector[DiskImage.SECTOR.LENGTH];
        } else {
            cbSector = sector['length'] || 512;
            delete sector['length'];
        }

        let adw = sector[DiskImage.SECTOR.DATA];
        if (adw != undefined) {
            delete sector[DiskImage.SECTOR.DATA];
        } else {
            let cdw = 0;
            adw = sector['data'];
            if (adw == undefined) {
                adw = [dwPattern];
                this.assert(dwPattern != undefined);
            } else {
                cdw = adw.length;
                delete sector['data'];
            }
        }

        delete sector[DiskImage.SECTOR.FILE_INFO];
        delete sector[DiskImage.SECTOR.FILE_OFFSET];

        sector[DiskImage.SECTOR.CYLINDER] = iCylinder;
        sector[DiskImage.SECTOR.HEAD] = iHead;
        sector[DiskImage.SECTOR.ID] = idSector;
        sector[DiskImage.SECTOR.LENGTH] = cbSector;
        sector[DiskImage.SECTOR.DATA] = adw;

        return this.initSector(sector, adw, cbSector, dwPattern);
    }

    /**
     * initSector(sector, adw, cbSector, dwPattern)
     *
     * @this {DiskImage}
     * @param {Sector} sector
     * @param {Array.<number>} adw
     * @param {number} cbSector
     * @param {number} [dwPattern] (undefined for new JSON disk images, because they simply store any final repeating value as the last DATA value)
     * @returns {Sector}
     */
    initSector(sector, adw, cbSector, dwPattern)
    {
        let cdw = cbSector >> 2;
        let dwPrev = null, cPrev = 0;
        for (let idw = 0; idw < cdw; idw++) {
            let dw = adw[idw];
            if (dw == undefined) {
                if (dwPattern != undefined) {
                    dw = dwPattern;
                } else {
                    dw = adw[adw.length-1];
                }
                adw[idw] = dw;
            }
            if (dwPrev === dw) {
                cPrev++;
            } else {
                dwPrev = dw;
                cPrev = 0;
            }
        }
        adw.length -= cPrev;
        /*
         * To be backward-compatible with the checksumming logic used with older JSON disk images (where
         * any ending pattern was stored in a separate 'pattern' property and omitted from the 'data' array),
         * we must omit the final data value from *our* checksum as well, but only if it's the final value
         * in a less-than-full sector.
         */
        cdw = adw.length < cdw? adw.length - 1 : adw.length;
        let dwChecksum = 0;
        for (let idw = 0; idw < cdw; idw++) {
            dwChecksum = (dwChecksum + adw[idw]) & (0xffffffff|0);
        }
        this.dwChecksum = (this.dwChecksum + dwChecksum) & (0xffffffff|0);
        if (this.fWritable) {
            /*
             * If this disk is writable (ie, will be loaded into a machine with a read/write drive),
             * then we also maintain the following information on a per-sector basis, as sectors are modified:
             *
             *      iModify:    index of first modified dword in sector
             *      cModify:    number of modified dwords in sector
             */
            sector.iModify = sector.cModify = 0;
        }
        return sector;
    }

    /**
     * getData(dbDisk)
     *
     * @this {DiskImage}
     * @param {DataBuffer} dbDisk
     * @returns {boolean} (true if successful, false if error)
     */
    getData(dbDisk)
    {
        if (this.aDiskData) {
            let ib = 0;
            let aDiskData = this.aDiskData;
            for (let iCylinder = 0; iCylinder < aDiskData.length; iCylinder++) {
                for (let iHead = 0; iHead < aDiskData[iCylinder].length; iHead++) {
                    for (let iSector = 0; iSector < aDiskData[iCylinder][iHead].length; iSector++) {
                        let sector = aDiskData[iCylinder][iHead][iSector];
                        if (sector) {
                            let n = sector[DiskImage.SECTOR.LENGTH];
                            for (let i = 0; i < n; i++) {
                                let b = this.read(sector, i);
                                this.assert(b >= 0);
                                dbDisk.writeUInt8(b, ib++);
                            }
                        }
                    }
                }
            }
            if (this.abOrigBPB.length) {
                let off = this.abOrigBPB.shift();
                for (let i = DiskImage.BPB.JMP_OPCODE; i < DiskImage.BPB.LARGE_SECS+4; i++) {
                    dbDisk.writeUInt8(this.abOrigBPB[i - DiskImage.BPB.JMP_OPCODE], off + i);
                }
            }
            this.assert(ib == dbDisk.length);
            return true;
        }
        return false;
    }

    /**
     * getJSON(fnHash, fLegacy, indent)
     *
     * If a disk image contains a recognized volume type (eg, FAT12, FAT16), we now prefer to produce an
     * "extended" JSON image, which will include a volume table (of volume descriptors), a file table (of
     * file descriptors), and sector-level "metadata" which, for every used sector, refers back to a file
     * in the file table (along with a file offset).
     *
     * To create a "legacy" JSON image, without any "extended" information, set fLegacy to true.
     *
     * @this {DiskImage}
     * @param {function(Array,string)} [fnHash]
     * @param {boolean} [fLegacy] (must be explicitly set to true to generate a "legacy" JSON disk image)
     * @param {number} [indent] (indentation is not recommended, due to significant bloat)
     * @returns {string}
     */
    getJSON(fnHash, fLegacy = false, indent = 0)
    {
        let volTable, fileTable;
        if (!fLegacy) {
            if (this.buildTables(this.fromJSON)) {
                volTable = [];
                for (let iVolume = 0; iVolume < this.volTable.length; iVolume++) {
                    volTable.push(this.getVolDesc(this.volTable[iVolume]));
                }
                fileTable = [];
                for (let iFile = 0; iFile < this.fileTable.length; iFile++) {
                    let file = this.fileTable[iFile];
                    if (file.name == "." || file.name == "..") continue;
                    let desc = this.getFileDesc(file, false, fnHash);
                    // let indentDesc = desc[DiskImage.FILEDESC.MODULE]? 4 : 0;
                    fileTable.push(JSON.stringify(desc, null, 0));
                }
            }
        } else {
            this.deleteTables();
        }
        let imageInfo = {
            [DiskImage.IMAGE.TYPE]: DiskImage.TYPE.CHS,
            [DiskImage.IMAGE.NAME]: this.diskName,
            [DiskImage.IMAGE.HASH]: this.hash,
            [DiskImage.IMAGE.CHECKSUM]: this.dwChecksum,
            [DiskImage.IMAGE.CYLINDERS]: this.nCylinders,
            [DiskImage.IMAGE.HEADS]: this.nHeads,
            [DiskImage.IMAGE.TRACKDEF]: this.nSectors,
            [DiskImage.IMAGE.SECTORDEF]: this.cbSector,
            [DiskImage.IMAGE.DISKSIZE]: this.cbDiskData,
            [DiskImage.IMAGE.DISKSIZE]: this.cbDiskData,
            [DiskImage.IMAGE.ORIGBPB]: JSON.stringify(this.abOrigBPB),
            [DiskImage.IMAGE.VERSION]: Device.VERSION,
            [DiskImage.IMAGE.REPOSITORY]: Device.REPOSITORY,
            [DiskImage.IMAGE.COMMAND]: this.args,
        };
        if (!this.fBPBModified) {
            delete imageInfo[DiskImage.IMAGE.ORIGBPB];
        }
        let sImageInfo = JSON.stringify(imageInfo, null, indent + 2);
        let sVolTable, sFileTable;
        if (fileTable) {
            sVolTable = JSON.stringify(volTable, null, indent + 2);
            sFileTable = '';
            fileTable.forEach((desc) => {
                if (sFileTable) sFileTable += ',\n';
                sFileTable += '  ' + desc;
            });
            sFileTable = '[\n' + sFileTable + '\n]';
        }
        let sDiskData = JSON.stringify(this.aDiskData, null, indent);
        let sImageData = "{\n\"" + DiskImage.DESC.IMAGE + "\": " + sImageInfo + ",\n\"" + (sVolTable? DiskImage.DESC.VOLUMES + "\": " + sVolTable + ",\n\"" : "") + (sFileTable? DiskImage.DESC.FILES + "\": " + sFileTable + ",\n\"" : "") + DiskImage.DESC.DISKDATA + "\":" + sDiskData + "\n}";
        return sImageData;
    }

    /**
     * findFile(sName)
     *
     * @param {string} name
     * @return {Object|null}
     */
    findFile(name)
    {
        let desc = null;
        if (this.buildTables()) {
            name = name.toUpperCase();
            if (this.fileTable) {
                for (let i = 0; i < this.fileTable.length; i++) {
                    let file = this.fileTable[i];
                    if (name == file.name) {
                        desc = this.getFileDesc(file, true);
                        break;
                    }
                }
            }
        }
        return desc;
    }

    /**
     * getChecksum()
     *
     * NOTE: As noted in initSector(), our checksums are somewhat constrained by compatibility with previous JSON formats;
     * in particular, for sectors that end with a repeating value, only the DATA values up to but NOT including that final
     * repeating value are checksummed.
     *
     * Technically, the checksums we calculated for older JSON formats should have repeatedly summed their 'pattern' value
     * as well.  But they didn't.  And I would like to avoid checksum warnings for anyone loading the new JSON format for the
     * first time, due to an old checksum stored in their browser's local storage.  The warnings aren't fatal, but they do
     * cause any saved machine state to be discarded, since the validity of a machine state is predicated on all the original
     * inputs (including the original diskette images) matching the current inputs.  And while it's unfortunate that our
     * checksums didn't (and still don't) sum the entire image, the limited purpose that they serve is still satisfied.
     *
     * TODO: Add a new "full" checksum property to DiskImage that checksums the entire disk image, including repeated values,
     * along with an option to return the "full" checksum here.
     *
     * @this {DiskImage}
     * @returns {number}
     */
    getChecksum()
    {
        return this.dwChecksum;
    }

    /**
     * getFiles()
     *
     * @this {DiskImage}
     * @returns {number}
     */
    getFiles()
    {
        return this.fileTable.length;
    }

    /**
     * getName()
     *
     * @this {DiskImage}
     * @returns {string}
     */
    getName()
    {
        return this.diskName.replace(/\.[a-z]+$/i, "");
    }

    /**
     * getSize()
     *
     * @this {DiskImage}
     * @returns {number|undefined}
     */
    getSize()
    {
        return this.cbDiskData;
    }

    /**
     * setArgs(args)
     *
     * @this {DiskImage}
     * @param {string} args
     */
    setArgs(args)
    {
        this.args = args;
    }

    /**
     * parseSuppData()
     *
     * @this {DiskImage}
     * @param {string} suppData
     * @returns {Object}
     */
    parseSuppData(suppData)
    {
        let suppObj = {};
        if (suppData) {
            let aSuppData = suppData.split(/[ \t]*MFM Sector\s*\n/);
            for (let i = 1; i < aSuppData.length; i++) {
                let metaData = aSuppData[i].match(/Sector ID:([0-9]+)[\s\S]*?Track ID:([0-9]+)[\s\S]*?Side ID:([0-9]+)[\s\S]*?Size:([0-9]+)[\s\S]*?DataMark:0x([0-9A-F]+)[\s\S]*?Head CRC:0x([0-9A-F]+)\s+\(([^)]*)\)[\s\S]*?Data CRC:0x([0-9A-F]+)\s+\(([^)]*)\)/);
                if (metaData) {
                    let data = [];
                    let sectorID = +metaData[1];
                    let trackID = +metaData[2];
                    let headID = +metaData[3];
                    let length = +metaData[4];
                    let dataMark = parseInt(metaData[5], 16);
                    let headCRC = parseInt(metaData[6], 16);
                    let headError = metaData[7].toLowerCase() != "ok";
                    let dataCRC = parseInt(metaData[8], 16)
                    let dataError = (metaData[9].toLowerCase() == "ok")? 0 : -1;
                    let matchData, reData = /([0-9A-F]+)\|([^|]*)\|/g;
                    while ((matchData = reData.exec(aSuppData[i]))) {
                        let shift = 0, dw = 0;
                        let matchByte, reByte = /\s+([0-9A-F]+)/g;
                        while ((matchByte = reByte.exec(matchData[2]))) {
                            dw |= parseInt(matchByte[1], 16) << shift;
                            shift += 8;
                            if (shift == 32) {
                                data.push(dw);
                                shift = dw = 0;
                            }
                        }
                        if (shift) data.push(dw);
                    }
                    if (!suppObj[trackID]) suppObj[trackID] = {};
                    if (!suppObj[trackID][headID]) suppObj[trackID][headID] = [];
                    let sector = {sectorID, length, dataMark, headCRC, headError, dataCRC, dataError, data};
                    suppObj[trackID][headID].push(sector);
                }
            }
        }
        return suppObj;
    }

    /**
     * read(sector, iByte, fCompare)
     *
     * @this {DiskImage}
     * @param {Sector} sector (returned from a previous seek)
     * @param {number} iByte (byte index within the given sector)
     * @param {boolean} [fCompare] is true if this write-compare read
     * @returns {number} the specified (unsigned) byte, or -1 if no more data in the sector
     */
    read(sector, iByte, fCompare)
    {
        let b = -1;
        if (sector) {
            if (Device.DEBUG && !iByte && !fCompare) {
                this.printf(Device.MESSAGE.DISK, 'read("%s",CHS=%d:%d:%d)\n', this.diskName, sector[DiskImage.SECTOR.CYLINDER], sector[DiskImage.SECTOR.HEAD], sector[DiskImage.SECTOR.ID]);
            }
            if (iByte < sector[DiskImage.SECTOR.LENGTH]) {
                let adw = sector[DiskImage.SECTOR.DATA];
                let idw = iByte >> 2;
                let dw = (idw < adw.length? adw[idw] : adw[adw.length-1]);
                b = ((dw >> ((iByte & 0x3) << 3)) & 0xff);
            }
        }
        return b;
    }

    /**
     * seek(iCylinder, iHead, idSector, sectorPrev, done)
     *
     * TODO: There's some dodgy code in seek() that allows floppy images to be dynamically
     * reconfigured with more heads and/or sectors/track, and it does so by peeking at more drive
     * properties.  That code used to be in the FDC component, where it was perfectly reasonable
     * to access those properties.  We need a cleaner interface back to the drive, similar to the
     * info() interface we provide to the controller.
     *
     * Whether or not the "dynamic reconfiguration" feature itself is perfectly reasonable is,
     * of course, a separate question.
     *
     * @this {DiskImage}
     * @param {number} iCylinder
     * @param {number} iHead
     * @param {number} idSector
     * @param {Sector|null} [sectorPrev]
     * @param {function(Sector,boolean)} [done]
     * @returns {Sector|null} is the requested sector, or null if not found (or not available yet)
     */
    seek(iCylinder, iHead, idSector, sectorPrev, done)
    {
        let sector = null;
        let drive = this.drive;
        let cylinder = this.aDiskData[iCylinder];
        if (cylinder) {
            let i;
            let track = cylinder[iHead];
            /*
             * The following code allows a single-sided diskette image to be reformatted (ie, "expanded")
             * as a double-sided image, provided the drive has more than one head (see drive.nHeads).
             *
             * NOTE: Strangely, we must ignore the number of drive heads both here and in doFormat(); otherwise,
             * PC DOS 1.10 "FORMAT /1" will fail.  Even though "/1" means format as a single-sided diskette, FORMAT
             * still attempts to format the first track with head 1.
             */
            if (!track && drive && drive.bFormatting && iHead < 2 /* drive.nHeads */) {
                track = new Array(drive.bSectorEnd);
                for (i = 0; i < track.length; i++) {
                    track[i] = this.buildSector(iCylinder, iHead, i + 1, drive.nBytes);
                }
                /*
                 * TODO: This is more dodginess, because we can't be certain that every cylinder on the disk
                 * will receive the same "expanded" treatment, but functions like getSector() rely on instance
                 * properties (eg, this.nHeads), on the assumption that the disk's geometry is homogeneous.
                 */
                if (iHead < drive.nHeads) {
                    cylinder[iHead] = track;
                    this.nHeads = iHead + 1;
                }
            }
            if (track) {
                for (i = 0; i < track.length; i++) {
                    if (track[i] && track[i][DiskImage.SECTOR.ID] == idSector) {
                        sector = track[i];
                        /*
                         * When confronted with a series of sectors with the same sector ID (as found, for example, on
                         * the 1984 King's Quest copy-protected diskette), we're supposed to advance to another sector in
                         * the series.  So if the current sector matches the previous sector, we'll peek at the next sector
                         * (if any), and if it has the same sector ID, then we'll choose that sector instead.
                         */
                        if (sectorPrev && sectorPrev == sector) {
                            let j = i, sectorNext;
                            while (true) {
                                if (++j >= track.length) j = 0;
                                sectorNext = track[j];
                                if (sectorNext == sector) break;
                                if (sectorNext[DiskImage.SECTOR.ID] == idSector) {
                                    sector = sectorNext;
                                    i = j;
                                    break;
                                }
                            }
                        }
                        break;
                    }
                }
                /*
                 * The following code allows an 8-sector track to be reformatted (ie, "expanded") as a 9-sector track.
                 */
                if (!sector && drive && drive.bFormatting && drive.bSector == 9) {
                    sector = track[i] = this.buildSector(iCylinder, iHead, drive.bSector, drive.nBytes);
                    /*
                     * TODO: This is more dodginess, because we can't be certain that every track on the disk
                     * will receive the same "expanded" treatment, but functions like getSector() rely on instance
                     * properties (eg, this.nSectors), on the assumption that the disk's geometry is homogeneous.
                     */
                    if (this.nSectors < drive.bSector) this.nSectors = drive.bSector;
                }
            }
        }
        if (done) done(sector, false);
        return sector;
    }

    /**
     * write(sector, iByte, b)
     *
     * @this {DiskImage}
     * @param {Sector} sector (returned from a previous seek)
     * @param {number} iByte (byte index within the given sector)
     * @param {number} b the byte value to write
     * @returns {boolean|null} true if write successful, false if write-protected, null if out of bounds
     */
    write(sector, iByte, b)
    {
        if (!this.fWritable) return false;

        if (Device.DEBUG && !iByte) {
            this.printf(Device.MESSAGE.DISK, 'write("%s",CHS=%d:%d:%d)\n', this.diskName, sector.iCylinder, sector.iHead, sector[DiskImage.SECTOR.ID]);
        }

        if (iByte < sector[DiskImage.SECTOR.LENGTH]) {
            if (b != this.read(sector, iByte, true)) {
                let adw = sector[DiskImage.SECTOR.DATA];
                let dwPattern = adw[adw.length-1];
                let idw = iByte >> 2;
                let nShift = (iByte & 0x3) << 3;
                /*
                 * Ensure every byte up to the specified byte is properly initialized.
                 */
                for (let i = adw.length; i <= idw; i++) adw[i] = dwPattern;
                if (!sector.cModify) {
                    sector.iModify = idw;
                    sector.cModify = 1;
                } else if (idw < sector.iModify) {
                    sector.cModify += sector.iModify - idw;
                    sector.iModify = idw;
                } else if (idw >= sector.iModify + sector.cModify) {
                    sector.cModify += idw - (sector.iModify + sector.cModify) + 1;
                }
                adw[idw] = (adw[idw] & ~(0xff << nShift)) | (b << nShift);
            }
            return true;
        }
        return null;
    }
}

/*
 * Top-level descriptors in "extended" JSON disk images.
 */
DiskImage.DESC = {
    IMAGE:      'imageInfo',
    VOLUMES:    'volTable',
    FILES:      'fileTable',
    DISKDATA:   'diskData'
};

/*
 * Supported image types.
 */
DiskImage.TYPE = {
    CHS:        'CHS'
};

/*
 * Image descriptor properties.
 */
DiskImage.IMAGE = {
    TYPE:       'type',
    NAME:       'name',
    HASH:       'hash',
    CHECKSUM:   'checksum',
    CYLINDERS:  'cylinders',
    HEADS:      'heads',
    TRACKDEF:   'trackDefault',
    SECTORDEF:  'sectorDefault',
    DISKSIZE:   'diskSize',
    ORIGBPB:    'bootSector',
    VERSION:    'version',
    REPOSITORY: 'repository',
    COMMAND:    'diskdump.js'
};

/*
 * Volume descriptor properties.
 */
DiskImage.VOLDESC = {
    MEDIA_ID:   'idMedia',          // media ID
    LBA_VOL:    'lbaStart',         // LBA of volume
    LBA_TOTAL:  'lbaTotal',         // total blocks in volume
    FAT_ID:     'idFAT',            // type of FAT (ie, 12 or 16)
    VBA_FAT:    'vbaFAT',           // VBA of first block of (first) FAT
    VBA_ROOT:   'vbaRoot',          // VBA of root directory
    ROOT_TOTAL: 'rootTotal',        // total entries in root directory
    VBA_DATA:   'vbaData',          // VBA of data area
    CLUS_SECS:  'clusSecs',         // number of sectors per cluster
    CLUS_MAX:   'clusMax',          // maximum valid cluster number
    CLUS_BAD:   'clusBad',          // total bad clusters
    CLUS_FREE:  'clusFree',         // total free clusters
    CLUS_TOTAL: 'clusTotal'         // total clusters
};

/*
 * File descriptor properties.
 */
DiskImage.FILEDESC = {
    VOL:        'vol',
    PATH:       'path',
    NAME:       'name',
    ATTR:       'attr',
    DATE:       'date',
    SIZE:       'size',
    HASH:       'hash',
    MODULE:     'module',
    MODNAME:    'name',
    MODDESC:    'description',
    MODSEGS:    'segments'
};

/*
 * Sector object "public" properties.
 */
DiskImage.SECTOR = {
    CYLINDER:   'c',                // cylinder number (0-based) [formerly iCylinder]
    HEAD:       'h',                // head number (0-based) [formerly iHead]
    ID:         's',                // sector ID (generally 1-based, except for unusual/copy-protected disks) [formerly 'sector']
    LENGTH:     'l',                // sector length, in bytes (generally 512, except for unusual/copy-protected disks) [formerly 'length']
    DATA:       'd',                // array of signed 32-bit values (if less than length/4, the last value is repeated) [formerly 'data']
    FILE_INFO:  'f',                // "extended" JSON disk images only [formerly file]
    FILE_OFFSET:'o',                // "extended" JSON disk images only [formerly offFile]
                                    // [no longer used: 'pattern']
    /*
     * The following properties occur very infrequently (and usually only in copy-protected or degraded disk images),
     * hence the longer, more meaningful IDs.
     */
    DATA_CRC:   'dataCRC',
    DATA_ERROR: 'dataError',
    DATA_MARK:  'dataMark',
    HEAD_CRC:   'headCRC',
    HEAD_ERROR: 'headError'
};

DiskImage.MBR = {
    PARTITIONS: {
        OFFSET:     0x1BE,
        ENTRY: {
            STATUS:         0x00,   // 1-byte (0x80 if active)
            CHS_FIRST:      0x01,   // 3-byte CHS specifier of first partition sector
            TYPE:           0x04,   // 1-byte TYPE (see below)
            CHS_LAST:       0x05,   // 3-byte CHS specifier of last partition sector
            VBA_FIRST:      0x08,   // 4-byte Volume Block Address
            VBA_TOTAL:      0x0C,   // 4-byte Volume Block Address
        },
        ENTRY_LENGTH:       0x10,
        STATUS: {
            ACTIVE:         0x80,   // ie, bootable
            INACTIVE:       0x00
        },
        TYPE: {
            EMPTY:          0x00,
            FAT12_PRIMARY:  0x01,   // DOS 2.0 and up (12-bit FAT)
            FAT16_PRIMARY:  0x04,   // DOS 3.0 and up (16-bit FAT)
            EXTENDED:       0x05    // DOS 3.3 and up (must reside within the first 8Gb)
        }
    },
    SIG_OFFSET:     0x1FE,
    SIGNATURE:      0xAA55          // to be clear, the low byte (at offset 0x1FE) is 0x55 and the high byte (at offset 0x1FF) is 0xAA
};

/*
 * Boot sector offsets (and assorted constants) in DOS-compatible boot sectors (DOS 2.0 and up)
 *
 * WARNING: I've heard apocryphal stories about SIGNATURE being improperly reversed on some systems
 * (ie, 0x55AA instead 0xAA55) -- perhaps by a dyslexic programmer -- so be careful out there.
 */
DiskImage.BOOT = {
    SIG_OFFSET:     0x1FE,
    SIGNATURE:      0xAA55      // to be clear, the low byte (at offset 0x1FE) is 0x55 and the high byte (at offset 0x1FF) is 0xAA
};

/*
 * PCJS_LABEL is our default label, used whenever a more suitable label (eg, the disk image's folder name)
 * is not available (or not supplied), and PCJS_OEM is inserted into any DiskImage-generated diskette images.
 */
DiskImage.PCJS_LABEL = "PCJSDISK";
DiskImage.PCJS_OEM   = "PCJS.ORG";

/*
 * BIOS Parameter Block (BPB) offsets in DOS-compatible boot sectors (DOS 2.x and up)
 *
 * Technically, JMP_OPCODE and OEM_STRING are not part of a BPB, but for simplicity's sake, this is where we're
 * recording those offsets.
 *
 * NOTE: DOS 2.x OEM documentation says that the words starting at offset 0x018 (TRACK_SECS, TOTAL_HEADS, and HIDDEN_SECS)
 * are optional, but even the DOS 2.0 FORMAT utility initializes all three of those words.  There may be some OEM media out
 * there with BPBs that are only valid up to offset 0x018, but I've not run across any media like that.
 *
 * DOS 3.20 added LARGE_SECS, but unfortunately, it was added as a 2-byte value at offset 0x01E.  DOS 3.31 decided
 * to make both HIDDEN_SECS and LARGE_SECS 4-byte values, which meant that LARGE_SECS had to move from 0x01E to 0x020.
 */
DiskImage.BPB = {
    JMP_OPCODE:     0x000,      // 1 byte for a JMP opcode, followed by a 1 or 2-byte offset
    OEM_STRING:     0x003,      // 8 bytes
    SECTOR_BYTES:   0x00B,      // 2 bytes: bytes per sector (eg, 0x200 or 512)
    CLUSTER_SECS:   0x00D,      // 1 byte: sectors per cluster (eg, 1)
    RESERVED_SECS:  0x00E,      // 2 bytes: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (eg, 1)
    TOTAL_FATS:     0x010,      // 1 byte: FAT copies (eg, 2)
    ROOT_DIRENTS:   0x011,      // 2 bytes: root directory entries (eg, 0x40 or 64) 0x40 * 0x20 = 0x800 (1 sector is 0x200 bytes, total of 4 sectors)
    TOTAL_SECS:     0x013,      // 2 bytes: number of sectors (eg, 0x140 or 320); if zero, refer to LARGE_SECS
    MEDIA_ID:       0x015,      // 1 byte: media ID (see DiskImage.FAT.MEDIA_*); should also match the first byte of the FAT (aka FAT ID)
    FAT_SECS:       0x016,      // 2 bytes: sectors per FAT (eg, 1)
    TRACK_SECS:     0x018,      // 2 bytes: sectors per track (eg, 8)
    TOTAL_HEADS:    0x01A,      // 2 bytes: number of heads (eg, 1)
    HIDDEN_SECS:    0x01C,      // 2 bytes (DOS 2.x) or 4 bytes (DOS 3.31 and up): number of hidden sectors (always 0 for non-partitioned media)
    LARGE_SECS:     0x020       // 4 bytes (DOS 3.31 and up): number of sectors if TOTAL_SECS is zero
};

/*
 * The BPBs that buildDiskFromBuffer() currently supports; these BPBs should be in order of smallest to largest capacity,
 * to help ensure we don't select a disk format larger than necessary.
 */
DiskImage.aDefaultBPBs = [
  [                             // define BPB for 160Kb diskette
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x20, 0x31, 0x2E, 0x30,     // "IBM  1.0" (this is a fake OEM signature)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x01,                       // 0x0D: sectors per cluster (1)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0x40, 0x00,                 // 0x11: root directory entries (0x40 or 64)  0x40 * 0x20 = 0x800 (1 sector is 0x200 bytes, total of 4 sectors)
    0x40, 0x01,                 // 0x13: number of sectors (0x140 or 320)
    0xFE,                       // 0x15: media ID (eg, 0xFF: 320Kb, 0xFE: 160Kb, 0xFD: 360Kb, 0xFC: 180Kb)
    0x01, 0x00,                 // 0x16: sectors per FAT (1)
    0x08, 0x00,                 // 0x18: sectors per track (8)
    0x01, 0x00,                 // 0x1A: number of heads (1)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
  [                             // define BPB for 320Kb diskette
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x20, 0x31, 0x2E, 0x30,     // "IBM  1.0" (this is a real OEM signature)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x02,                       // 0x0D: sectors per cluster (2)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0x70, 0x00,                 // 0x11: root directory entries (0x70 or 112)  0x70 * 0x20 = 0xE00 (1 sector is 0x200 bytes, total of 7 sectors)
    0x80, 0x02,                 // 0x13: number of sectors (0x280 or 640)
    0xFF,                       // 0x15: media ID (eg, 0xFF: 320Kb, 0xFE: 160Kb, 0xFD: 360Kb, 0xFC: 180Kb)
    0x01, 0x00,                 // 0x16: sectors per FAT (1)
    0x08, 0x00,                 // 0x18: sectors per track (8)
    0x02, 0x00,                 // 0x1A: number of heads (2)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
  [                             // define BPB for 180Kb diskette
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x20, 0x32, 0x2E, 0x30,     // "IBM  2.0" (this is a fake OEM signature)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x01,                       // 0x0D: sectors per cluster (1)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0x40, 0x00,                 // 0x11: root directory entries (0x40 or 64)  0x40 * 0x20 = 0x800 (1 sector is 0x200 bytes, total of 4 sectors)
    0x68, 0x01,                 // 0x13: number of sectors (0x168 or 360)
    0xFC,                       // 0x15: media ID (eg, 0xFF: 320Kb, 0xFE: 160Kb, 0xFD: 360Kb, 0xFC: 180Kb)
    0x02, 0x00,                 // 0x16: sectors per FAT (2)
    0x09, 0x00,                 // 0x18: sectors per track (9)
    0x01, 0x00,                 // 0x1A: number of heads (1)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
  [                             // define BPB for 360Kb diskette
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x20, 0x32, 0x2E, 0x30,     // "IBM  2.0" (this is a real OEM signature)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x02,                       // 0x0D: sectors per cluster (2)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0x70, 0x00,                 // 0x11: root directory entries (0x70 or 112)  0x70 * 0x20 = 0xE00 (1 sector is 0x200 bytes, total of 7 sectors)
    0xD0, 0x02,                 // 0x13: number of sectors (0x2D0 or 720)
    0xFD,                       // 0x15: media ID (eg, 0xFF: 320Kb, 0xFE: 160Kb, 0xFD: 360Kb, 0xFC: 180Kb)
    0x02, 0x00,                 // 0x16: sectors per FAT (2)
    0x09, 0x00,                 // 0x18: sectors per track (9)
    0x02, 0x00,                 // 0x1A: number of heads (2)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
  [                             // define BPB for 1.2Mb diskette
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x31, 0x30, 0x2E, 0x31,     // "10.0" (which I believe was used on IBM OS/2 1.0 diskettes)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x01,                       // 0x0D: sectors per cluster (1)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0xE0, 0x00,                 // 0x11: root directory entries (0xe0 or 224)  0xe0 * 0x20 = 0x1c00 (1 sector is 0x200 bytes, total of 14 sectors)
    0x60, 0x09,                 // 0x13: number of sectors (0x960 or 2400)
    0xF9,                       // 0x15: media ID (0xF9 was used for 1228800-byte diskettes, and later for 737280-byte diskettes)
    0x07, 0x00,                 // 0x16: sectors per FAT (7)
    0x0f, 0x00,                 // 0x18: sectors per track (15)
    0x02, 0x00,                 // 0x1A: number of heads (2)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
  [                             // define BPB for 720Kb diskette (2 sector/cluster format more commonly used)
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x20, 0x35, 0x2E, 0x30,     // "IBM  5.0" (this is a real OEM signature)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x02,                       // 0x0D: sectors per cluster (2)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0x70, 0x00,                 // 0x11: root directory entries (0x70 or 112)  0x70 * 0x20 = 0xE00 (1 sector is 0x200 bytes, total of 7 sectors)
    0xA0, 0x05,                 // 0x13: number of sectors (0x5A0 or 1440)
    0xF9,                       // 0x15: media ID
    0x03, 0x00,                 // 0x16: sectors per FAT (3)
    0x09, 0x00,                 // 0x18: sectors per track (9)
    0x02, 0x00,                 // 0x1A: number of heads (2)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
  [                             // define BPB for 720Kb diskette (1 sector/cluster format used by PC DOS 4.01)
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x20, 0x34, 0x2E, 0x30,     // "IBM  4.0" (this is a real OEM signature)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x01,                       // 0x0D: sectors per cluster (1)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0x70, 0x00,                 // 0x11: root directory entries (0x70 or 112)  0x70 * 0x20 = 0xE00 (1 sector is 0x200 bytes, total of 7 sectors)
    0xA0, 0x05,                 // 0x13: number of sectors (0x5A0 or 1440)
    0xF9,                       // 0x15: media ID
    0x05, 0x00,                 // 0x16: sectors per FAT (5)
    0x09, 0x00,                 // 0x18: sectors per track (9)
    0x02, 0x00,                 // 0x1A: number of heads (2)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
  [                             // define BPB for 1.44Mb diskette
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x4d, 0x53, 0x44, 0x4F, 0x53, 0x35, 0x2E, 0x30,     // "MSDOS5.0" (an actual OEM signature, arbitrarily chosen for use here)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x01,                       // 0x0D: sectors per cluster (1)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0xE0, 0x00,                 // 0x11: root directory entries (0xe0 or 224)  0xe0 * 0x20 = 0x1c00 (1 sector is 0x200 bytes, total of 14 sectors)
    0x40, 0x0B,                 // 0x13: number of sectors (0xb40 or 2880)
    0xF0,                       // 0x15: media ID (0xF0 was used for 1474560-byte diskettes)
    0x09, 0x00,                 // 0x16: sectors per FAT (9)
    0x12, 0x00,                 // 0x18: sectors per track (18)
    0x02, 0x00,                 // 0x1A: number of heads (2)
    0x00, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ],
    /*
     * Here's some useful background information on a 10Mb PC XT fixed disk, partitioned with a single DOS partition.
     *
     * The BPB for a 10Mb "type 3" PC XT hard disk specifies 0x5103 or 20739 for TOTAL_SECS, which is the partition
     * size in sectors (10,618,368 bytes), whereas total disk size is 20808 sectors (10,653,696 bytes).  The partition
     * is 69 sectors smaller than the disk because the first sector is reserved for the MBR and 68 sectors (the entire
     * last cylinder) are reserved for diagnostics, head parking, etc.  This cylinder usage is confirmed by FDISK,
     * which reports that 305 cylinders (not 306) are assigned to the DOS partition.
     *
     * That 69-sector overhead is NOT overhead incurred by the FAT file system.  The FAT overhead is the boot sector
     * (1), FAT sectors (2 * 8), and root directory sectors (32), for a total of 49 sectors, leaving 20739 - 49 or
     * 20690 sectors.  Moreover, free space is measured in clusters, not sectors, and the partition uses 8 sectors/cluster,
     * leaving room for 2586.25 clusters.  Since a fractional cluster is not allowed, another 2 sectors are lost, for
     * a total of 51 sectors of FAT overhead.  So actual free space is (20739 - 51) * 512, or 10,592,256 bytes -- which
     * is exactly what is reported as the available space on a freshly formatted 10Mb PC XT fixed disk.
     *
     * Some sources on the internet (eg, http://www.wikiwand.com/en/Timeline_of_DOS_operating_systems) claim that the
     * file system overhead for the XT's 10Mb disk is "50 sectors".  As they explain:
     *
     *      "The fixed disk has 10,618,880 bytes of raw space: 305 cylinders (the equivalent of tracks) × 2 platters
     *      × 2 sides or heads per platter × 17 sectors per track = 20,740 sectors × 512 bytes per sector = 10,618,880
     *      bytes...."
     *
     * and:
     *
     *      "With DOS the only partition, the combined overhead is 50 sectors leaving 10,592,256 bytes for user data:
     *      DOS's FAT is eight sectors (16 sectors for two copies) + 32 sectors for the root directory, room for 512
     *      directory entries + 2 sectors (one master and one DOS boot sector) = 50 sectors...."
     *
     * However, that's incorrect.  First, the disk has 306 cylinders, not 305.  Second, there are TWO overhead values:
     * the overhead OUTSIDE the partition (69 sectors) and the overhead INSIDE the partition (51 sectors).  They failed
     * to account for the reserved cylinder in the first calculation and the fractional cluster in the second calculation,
     * and then they conflated the two values to produce a single (incorrect) result.
     *
     * Even if one were to assume that the disk had only 305 cylinders, that would only change the partitioning overhead
     * to 1 sector; the FAT file system overhead would still be 51 sectors.
     */
  [                             // define BPB for 10Mb hard drive
    0xEB, 0xFE, 0x90,           // 0x00: JMP instruction, following by 8-byte OEM signature
    0x50, 0x43, 0x4A, 0x53, 0x2E, 0x4F, 0x52, 0x47,     // PCJS_OEM
 // 0x49, 0x42, 0x4D, 0x20, 0x20, 0x32, 0x2E, 0x30,     // "IBM  2.0" (this is a real OEM signature)
    0x00, 0x02,                 // 0x0B: bytes per sector (0x200 or 512)
    0x08,                       // 0x0D: sectors per cluster (8)
    0x01, 0x00,                 // 0x0E: reserved sectors; ie, # sectors preceding the first FAT--usually just the boot sector (1)
    0x02,                       // 0x10: FAT copies (2)
    0x00, 0x02,                 // 0x11: root directory entries (0x200 or 512)  0x200 * 0x20 = 0x4000 (1 sector is 0x200 bytes, total of 0x20 or 32 sectors)
    0x03, 0x51,                 // 0x13: number of sectors (0x5103 or 20739; * 512 bytes/sector = 10,618,368 bytes = 10,369Kb = 10Mb)
    0xF8,                       // 0x15: media ID (eg, 0xF8: hard drive w/FAT12)
    0x08, 0x00,                 // 0x16: sectors per FAT (8)
      //
      // Wikipedia (http://en.wikipedia.org/wiki/File_Allocation_Table#BIOS_Parameter_Block) implies everything past
      // this point was introduced post-DOS 2.0.  However, DOS 2.0 merely said they were optional, and in fact, DOS 2.0
      // FORMAT always initializes the next 3 words.  A 4th word, LARGE_SECS, was added in DOS 3.20 at offset 0x1E,
      // and then in DOS 3.31, both HIDDEN_SECS and LARGE_SECS were widened from words to dwords.
      //
    0x11, 0x00,                 // 0x18: sectors per track (17)
    0x04, 0x00,                 // 0x1A: number of heads (4)
      //
      // PC DOS 2.0 actually stored 0x01, 0x00, 0x80, 0x00 here, so you can't rely on more than the first word.
      // TODO: Investigate PC DOS 2.0 BPB behavior (ie, what did the 0x80 mean)?
      //
    0x01, 0x00, 0x00, 0x00      // 0x1C: number of hidden sectors (always 0 for non-partitioned media)
  ]
];

/*
 * Common (supported) diskette geometries.
 *
 * Each entry in GEOMETRIES is an array of values in "CHS" order:
 *
 *      [# cylinders, # heads, # sectors/track, # bytes/sector, media ID]
 *
 * If the 4th value is omitted, the sector size is assumed to be 512.  The order of these "geometric" values mirrors
 * the structure of our JSON-encoded disk images, which consist of an array of cylinders, each of which is an array of
 * heads, each of which is an array of sector objects.
 */
DiskImage.GEOMETRIES = {
    163840:  [40,1,8,,0xFE],    // media ID 0xFE: 40 cylinders, 1 head (single-sided),   8 sectors/track, ( 320 total sectors x 512 bytes/sector ==  163840)
    184320:  [40,1,9,,0xFC],    // media ID 0xFC: 40 cylinders, 1 head (single-sided),   9 sectors/track, ( 360 total sectors x 512 bytes/sector ==  184320)
    327680:  [40,2,8,,0xFF],    // media ID 0xFF: 40 cylinders, 2 heads (double-sided),  8 sectors/track, ( 640 total sectors x 512 bytes/sector ==  327680)
    368640:  [40,2,9,,0xFD],    // media ID 0xFD: 40 cylinders, 2 heads (double-sided),  9 sectors/track, ( 720 total sectors x 512 bytes/sector ==  368640)
    737280:  [80,2,9,,0xF9],    // media ID 0xF9: 80 cylinders, 2 heads (double-sided),  9 sectors/track, (1440 total sectors x 512 bytes/sector ==  737280)
    1228800: [80,2,15,,0xF9],   // media ID 0xF9: 80 cylinders, 2 heads (double-sided), 15 sectors/track, (2400 total sectors x 512 bytes/sector == 1228800)
    1474560: [80,2,18,,0xF0],   // media ID 0xF0: 80 cylinders, 2 heads (double-sided), 18 sectors/track, (2880 total sectors x 512 bytes/sector == 1474560)
    2949120: [80,2,36,,0xF0],   // media ID 0xF0: 80 cylinders, 2 heads (double-sided), 36 sectors/track, (5760 total sectors x 512 bytes/sector == 2949120)
    /*
     * The following are some common disk sizes and their CHS values, since missing or bogus MBR and/or BPB values
     * might mislead us when attempting to determine the exact disk geometry.
     */
    10653696:[306,4,17],        // PC XT 10Mb hard drive (type 3)
    21411840:[615,4,17],        // PC AT 20Mb hard drive (type 2)
    /*
     * Assorted DEC disk formats.
     */
    256256:  [77, 1,26,128],    // RX01 single-platter diskette: 77 tracks, 1 head, 26 sectors/track, 128 bytes/sector, for a total of 256256 bytes
    2494464: [203,2,12,512],    // RK03 single-platter disk cartridge: 203 tracks, 2 heads, 12 sectors/track, 512 bytes/sector, for a total of 2494464 bytes
    5242880: [256,2,40,256],    // RL01K single-platter disk cartridge: 256 tracks, 2 heads, 40 sectors/track, 256 bytes/sector, for a total of 5242880 bytes
    10485760:[512,2,40,256]     // RL02K single-platter disk cartridge: 512 tracks, 2 heads, 40 sectors/track, 256 bytes/sector, for a total of 10485760 bytes
};

/*
 * Media ID (descriptor) bytes for DOS-compatible FAT-formatted disks (stored in the first byte of the FAT)
 */
DiskImage.FAT = {
    MEDIA_160KB:    0xFE,       // 5.25-inch, 1-sided,  8-sector, 40-track
    MEDIA_180KB:    0xFC,       // 5.25-inch, 1-sided,  9-sector, 40-track
    MEDIA_320KB:    0xFF,       // 5.25-inch, 2-sided,  8-sector, 40-track
    MEDIA_360KB:    0xFD,       // 5.25-inch, 2-sided,  9-sector, 40-track
    MEDIA_720KB:    0xF9,       //  3.5-inch, 2-sided,  9-sector, 80-track
    MEDIA_1200KB:   0xF9,       //  3.5-inch, 2-sided, 15-sector, 80-track
    MEDIA_FIXED:    0xF8,       // fixed disk (aka hard drive)
    MEDIA_1440KB:   0xF0,       //  3.5-inch, 2-sided, 18-sector, 80-track
    MEDIA_2880KB:   0xF0        //  3.5-inch, 2-sided, 36-sector, 80-track
};

/*
 * Cluster constants for 12-bit FATs (CLUSNUM_FREE, CLUSNUM_RES and CLUSNUM_MIN are the same for all FATs)
 */
DiskImage.FAT12 = {
    MAX_CLUSTERS:   4084,
    CLUSNUM_FREE:   0,          // this should NEVER appear in cluster chain (except at the start of an empty chain)
    CLUSNUM_RES:    1,          // reserved; this should NEVER appear in cluster chain
    CLUSNUM_MIN:    2,          // smallest valid cluster number
    CLUSNUM_MAX:    0xFF6,      // largest valid cluster number
    CLUSNUM_BAD:    0xFF7,      // bad cluster; this should NEVER appear in cluster chain
    CLUSNUM_EOC:    0xFF8       // end of chain (actually, anything from 0xFF8-0xFFF indicates EOC)
};

/*
 * Cluster constants for 16-bit FATs (CLUSNUM_FREE, CLUSNUM_RES and CLUSNUM_MIN are the same for all FATs)
 */
DiskImage.FAT16 = {
    MAX_CLUSTERS:   65524,
    CLUSNUM_FREE:   0,          // this should NEVER appear in cluster chain (except at the start of an empty chain)
    CLUSNUM_RES:    1,          // reserved; this should NEVER appear in cluster chain
    CLUSNUM_MIN:    2,          // smallest valid cluster number
    CLUSNUM_MAX:    0xFFF6,     // largest valid cluster number
    CLUSNUM_BAD:    0xFFF7,     // bad cluster; this should NEVER appear in cluster chain
    CLUSNUM_EOC:    0xFFF8      // end of chain (actually, anything from 0xFFF8-0xFFFF indicates EOC)
};

/*
 * Directory Entry offsets (and assorted constants) in FAT disk images
 *
 * NOTE: Versions of DOS prior to 2.0 used INVALID exclusively to mark available directory entries; any entry marked
 * UNUSED was actually considered USED.  In DOS 2.0 and up, UNUSED was added to indicate that all remaining entries were
 * unused, relieving it from having to initialize the rest of the sectors in the directory cluster(s).  And in fact,
 * you will likely encounter garbage in subsequent directory sectors if you read beyond the first UNUSED entry.
 *
 * For more details on MODTIME and MODDATE, see diskimage.js; in particular, buildDateTime() and getDSTAdjustedTime().
 */
DiskImage.DIRENT = {
    NAME:           0x000,      // 8 bytes
    EXT:            0x008,      // 3 bytes
    ATTR:           0x00B,      // 1 byte
    MODTIME:        0x016,      // 2 bytes: bits 15-11 is hour (0-31), bits 10-5 is minute (0-63), bits 4-0 is second/2 (0-31)
    MODDATE:        0x018,      // 2 bytes: bits 15-9 is year (0 for 1980, 127 for 2107), bits 8-5 is month (1-12), bits 4-0 is day (1-31)
    CLUSTER:        0x01A,      // 2 bytes
    SIZE:           0x01C,      // 4 bytes (typically zero for subdirectories)
    LENGTH:         0x20,       // 32 bytes total
    UNUSED:         0x00,       // indicates this and all subsequent directory entries are unused
    INVALID:        0xE5        // indicates this directory entry is unused
};

/*
 * Possible values for DIRENT.ATTR
 */
DiskImage.ATTR = {
    READONLY:       0x01,       // PC-DOS 2.0 and up
    HIDDEN:         0x02,
    SYSTEM:         0x04,
    VOLUME:         0x08,       // PC-DOS 2.0 and up
    SUBDIR:         0x10,       // PC-DOS 2.0 and up
    ARCHIVE:        0x20        // PC-DOS 2.0 and up
};
