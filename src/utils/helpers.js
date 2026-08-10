const normalizar = (texto) => {
    if (!texto) return "";
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
};

const levenshtein = (a, b) => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
};

const calcularSimilitud = (str1, str2) => {
    const s1 = normalizar(str1 || "");
    const s2 = normalizar(str2 || "");
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;
    
    const maxLength = Math.max(s1.length, s2.length);
    if (maxLength === 0) return 1;
    
    const distance = levenshtein(s1, s2);
    let similarity = (maxLength - distance) / maxLength;
    
    if (s1.length > 3 && s2.length > 3) {
        if (s1.includes(s2) || s2.includes(s1)) {
            similarity = Math.max(similarity, 0.8);
        }
    }
    
    return similarity;
};

module.exports = { normalizar, calcularSimilitud };
