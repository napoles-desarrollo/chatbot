const { normalizar, calcularSimilitud } = require('./src/utils/helpers');

console.log(normalizar('RX. COLUMNA CERVICAL AP'));
console.log(normalizar('rx columna cervical ap'));
console.log(calcularSimilitud('rx columna cervical ap', 'RX. COLUMNA CERVICAL AP'));

