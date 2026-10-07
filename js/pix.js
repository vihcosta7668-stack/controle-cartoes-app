// Pix "copia e cola" estático (BR Code / EMV), conforme o Manual de Padrões do Pix (BCB).

const campo = (id, valor) => {
  const v = String(valor);
  if (v.length > 99) throw new Error(`Campo ${id} longo demais`);
  return id + String(v.length).padStart(2, '0') + v;
};

export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const limpo = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 .\-]/g, '').trim().slice(0, max).toUpperCase();

export function normalizaChave(chave, tipo) {
  const c = String(chave || '').trim();
  switch (tipo) {
    case 'cpf': case 'cnpj': return c.replace(/\D/g, '');
    case 'telefone': { const d = c.replace(/\D/g, ''); return '+' + (d.startsWith('55') && d.length >= 12 ? d : '55' + d); }
    case 'email': return c.toLowerCase();
    default: return c; // aleatória (EVP)
  }
}

export function pixCopiaECola({ chave, tipo, nome, cidade, valor, txid = '***' }) {
  const k = normalizaChave(chave, tipo);
  if (!k) throw new Error('Chave Pix vazia');
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', k);
  let payload = campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986');
  if (valor && valor > 0) payload += campo('54', Number(valor).toFixed(2));
  payload += campo('58', 'BR') + campo('59', limpo(nome, 25) || 'RECEBEDOR') + campo('60', limpo(cidade, 15) || 'BRASIL');
  payload += campo('62', campo('05', txid));
  payload += '6304';
  return payload + crc16(payload);
}
