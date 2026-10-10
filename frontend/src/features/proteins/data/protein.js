export const AA3 = {
  A: 'ALA', R: 'ARG', N: 'ASN', D: 'ASP', C: 'CYS', Q: 'GLN', E: 'GLU', G: 'GLY', H: 'HIS',
  I: 'ILE', L: 'LEU', K: 'LYS', M: 'MET', F: 'PHE', P: 'PRO', S: 'SER', T: 'THR', W: 'TRP', Y: 'TYR', V: 'VAL',
};

export const AA_NAMES = {
  ALA: 'Alanina', ARG: 'Arginina', ASN: 'Asparagina', ASP: 'Aspartato', CYS: 'Cisteína', GLN: 'Glutamina',
  GLU: 'Glutamato', GLY: 'Glicina', HIS: 'Histidina', ILE: 'Isoleucina', LEU: 'Leucina', LYS: 'Lisina',
  MET: 'Metionina', PHE: 'Fenilalanina', PRO: 'Prolina', SER: 'Serina', THR: 'Treonina', TRP: 'Triptófano',
  TYR: 'Tirosina', VAL: 'Valina',
};

export const P01130_SEQUENCE = 'MGPWGWKLRWTVALLLAAAGTAVGDRCERNEFQCQDGKCISYKWVCDGSAECQDGSDESQETCLSVTCKSGDFSCGGRVNRCIPQFWRCDGQVDCDNGSDEQGCPPKTCSQDEFRCHDGKCISRQFVCDSDRDCLDGSDEASCPVLTCGPASFQCNSSTCIPQLWACDNDPDCEDGSDEWPQRCRGLYVFQGDSSPCSAFEFHCLSGECIHSSWRCDGGPDCKDKSDEENCAVATCRPDEFQCSDGNCIHGSRQCDREYDCKDMSDEVGCVNVTLCEGPNKFKCHSGECITLDKVCNMARDCRDWSDEPIKECGTNECLDNNGGCSHVCNDLKIGYECLCPDGFQLVAQRRCEDIDECQDPDTCSQLCVNLEGGYKCQCEEGFQLDPHTKACKAVGSIAYLFFTNRHEVRKMTLDRSEYTSLIPNLRNVVALDTEVASNRIYWSDLSQRMICSTQLDRAHGVSSYDTVISRDIQAPDGLAVDWIHSNIYWTDSVLGTVSVADTKGVKRKTLFRENGSKPRAIVVDPVHGFMYWTDWGTPAKIKKGGLNGVDIYSLVTENIQWPNGITLDLLSGRLYWVDSKLHSISSIDVNGGNRKTILEDEKRLAHPFSLAVFEDKVFWTDIINEAIFSANRLTGSDVNLLAENLLSPEDMVLFHNLTQPRGVNWCERTTLSNGGCQYLCLPAPQINPHSPKFTCACPDGMLLARDMRSCLTEAEAAVATQETSTVRLKVSSTAVRTQHTTTRPVPDTSRLPGATPGLTTVEIVTMSHQALGDVAGRGNEKKPSSVRALSIVLPIVLLVFLCLGVFLLWKNWRLKNINSINFDNPVYQKTTEDEVHICHNQDGYSYPSRQMVSLEDDVA';

/** @typedef {{ chain: string, authSeqId: number, insCode: string, compId: string, one: string }} Residue */
/** @type {{ id: string, accession: string, gene: string, name: string, organism: string, sequence: string, length: number, source: string, preview: string, pdb: string }[]} */
export const MOCK_PROTEINS = [
  {
    id: 'P01130',
    accession: 'P01130',
    gene: 'LDLR',
    name: 'Receptor de lipoproteínas de baja densidad',
    organism: 'Homo sapiens',
    sequence: P01130_SEQUENCE,
    length: P01130_SEQUENCE.length,
    source: 'Entrada PDB',
    preview: '/mock/P01130_preview.png',
    pdb: '/mock/P01130_model_0.pdb',
  },
];

export const DEFAULT_PROTEIN = MOCK_PROTEINS[0];

/** @type {Residue[]} */
export const RESIDUES = P01130_SEQUENCE.split('').map((one, index) => ({
  chain: 'A',
  authSeqId: index + 1,
  insCode: '',
  compId: AA3[one] ?? 'UNK',
  one,
}));

export function getProtein(id) {
  return MOCK_PROTEINS.find((protein) => protein.id === id) ?? DEFAULT_PROTEIN;
}
