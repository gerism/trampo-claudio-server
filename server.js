require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Área é fixa — a empresa sempre escolhe uma dessas. O cargo (função
// específica dentro da área) é texto livre, com autocomplete no front
// baseado nos cargos já cadastrados (rota /cargos abaixo).
const AREAS_VALIDAS = [
  'Construção', 'Comércio e Vendas', 'Alimentação', 'Domésticos e Cuidados',
  'Logística e Transporte', 'Indústria e Produção', 'Administrativo',
  'Beleza e Estética', 'Saúde', 'Educação', 'Rural e Agropecuária',
  'Segurança e Limpeza', 'Outros',
];

function areaValida(area) {
  return AREAS_VALIDAS.includes(area);
}

// Autocomplete de cargo — sugere cargos já usados antes, filtrando pelo
// que a empresa foi digitando. Pode opcionalmente restringir pela área
// já escolhida, pra sugestão vir mais certeira.
app.get('/cargos', async (req, res) => {
  const { q, area } = req.query;
  const params = [`%${q || ''}%`];
  let sql = `
    SELECT cargo, COUNT(*) as total
    FROM vagas
    WHERE ativa = true AND cargo ILIKE $1
  `;
  if (area) {
    params.push(area);
    sql += ` AND area = $2`;
  }
  sql += ` GROUP BY cargo ORDER BY total DESC LIMIT 8`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar cargos' });
  }
});

// Busca de vagas — por área, cargo e/ou bairro, tolerante a acento e
// pequenos erros de digitação (unaccent + pg_trgm), igual o ClaudioTem.
app.get('/vagas', async (req, res) => {
  const { area, cargo, bairro } = req.query;
  const params = [];
  const cond = ['ativa = true'];

  if (area) {
    params.push(area);
    cond.push(`area = $${params.length}`);
  }

  if (cargo) {
    params.push(cargo);
    const i = params.length;
    cond.push(`(
      unaccent(cargo) ILIKE '%' || unaccent($${i}) || '%'
      OR similarity(unaccent(cargo), unaccent($${i})) > 0.3
    )`);
  }

  if (bairro) {
    params.push(bairro);
    const i = params.length;
    cond.push(`(
      unaccent(bairro) ILIKE '%' || unaccent($${i}) || '%'
      OR similarity(unaccent(bairro), unaccent($${i})) > 0.3
    )`);
  }

  const sql = `SELECT * FROM vagas WHERE sinalizada = false AND ${cond.join(' AND ')} ORDER BY created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar vagas' });
  }
});

// Vagas da própria empresa (pra ela ver/editar/fechar as que publicou) —
// precisa vir ANTES de '/vagas/:id', mesmo bug de ordem de rotas que já
// mordeu o ClaudioTem antes.
app.get('/vagas/minhas', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ erro: 'device_id obrigatório' });

  try {
    const result = await pool.query(
      `SELECT * FROM vagas WHERE device_id = $1 ORDER BY created_at DESC`,
      [device_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar suas vagas' });
  }
});

app.get('/vagas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM vagas WHERE id = $1 AND sinalizada = false`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Vaga não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar vaga' });
  }
});

// Publicar vaga
app.post('/vagas', async (req, res) => {
  const { device_id, empresa_nome, whatsapp, area, cargo, descricao,
    tipo_contrato, salario, bairro } = req.body;

  if (!device_id || !empresa_nome || !whatsapp || !area || !cargo || !bairro) {
    return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
  }
  if (!areaValida(area)) {
    return res.status(400).json({ erro: 'Área inválida' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO vagas
       (device_id, empresa_nome, whatsapp, area, cargo, descricao, tipo_contrato, salario, bairro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [device_id, empresa_nome, whatsapp, area, cargo, descricao || null,
       tipo_contrato || null, salario || null, bairro]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao publicar vaga' });
  }
});

// Editar vaga (só quem publicou, validado por device_id)
app.put('/vagas/:id', async (req, res) => {
  const { id } = req.params;
  const { device_id, empresa_nome, whatsapp, area, cargo, descricao,
    tipo_contrato, salario, bairro, ativa } = req.body;

  if (!device_id || !empresa_nome || !whatsapp || !area || !cargo || !bairro) {
    return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
  }
  if (!areaValida(area)) {
    return res.status(400).json({ erro: 'Área inválida' });
  }

  try {
    const result = await pool.query(
      `UPDATE vagas SET
        empresa_nome = $1, whatsapp = $2, area = $3, cargo = $4, descricao = $5,
        tipo_contrato = $6, salario = $7, bairro = $8, ativa = COALESCE($9, ativa)
       WHERE id = $10 AND device_id = $11
       RETURNING *`,
      [empresa_nome, whatsapp, area, cargo, descricao || null, tipo_contrato || null,
       salario || null, bairro, ativa, id, device_id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ erro: 'Não autorizado a editar essa vaga' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao editar vaga' });
  }
});

// Marca a vaga como preenchida (ou reabre) — só quem publicou, validado
// por device_id. Mais simples que o PUT completo: só alterna o campo
// "ativa", sem precisar reenviar todos os outros dados da vaga. Assim que
// marcada como preenchida, some da busca (GET /vagas já filtra ativa=true).
app.post('/vagas/:id/marcar-preenchida', async (req, res) => {
  const { id } = req.params;
  const { device_id, preenchida } = req.body;

  if (!device_id) return res.status(400).json({ erro: 'device_id obrigatório' });

  try {
    const result = await pool.query(
      `UPDATE vagas SET ativa = $1 WHERE id = $2 AND device_id = $3 RETURNING *`,
      [!preenchida, id, device_id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ erro: 'Não autorizado a alterar essa vaga' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao atualizar vaga' });
  }
});

// Excluir vaga (só quem publicou)
app.delete('/vagas/:id', async (req, res) => {
  const { id } = req.params;
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ erro: 'device_id obrigatório' });

  try {
    const result = await pool.query(
      `DELETE FROM vagas WHERE id = $1 AND device_id = $2 RETURNING id`,
      [id, device_id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ erro: 'Não autorizado a excluir essa vaga' });
    }
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao excluir vaga' });
  }
});

// Denunciar vaga (conteúdo impróprio, vaga falsa, etc.)
app.post('/vagas/:id/denunciar', async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body || {};

  try {
    const vaga = await pool.query('SELECT id FROM vagas WHERE id = $1', [id]);
    if (vaga.rows.length === 0) {
      return res.status(404).json({ erro: 'Vaga não encontrada' });
    }

    await pool.query(
      'INSERT INTO denuncias_vaga (vaga_id, motivo) VALUES ($1, $2)',
      [id, motivo || 'Não especificado']
    );

    const contagem = await pool.query(
      'SELECT COUNT(*) FROM denuncias_vaga WHERE vaga_id = $1',
      [id]
    );
    const total = parseInt(contagem.rows[0].count, 10);

    if (total >= 3) {
      await pool.query('UPDATE vagas SET sinalizada = true WHERE id = $1', [id]);
      console.log(`Vaga ${id} sinalizada automaticamente (${total} denúncias) — escondida da busca.`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao registrar denúncia:', err);
    res.status(500).json({ erro: 'Erro ao registrar denúncia' });
  }
});

// ============================================
// ADMIN (mesmo padrão do ClaudioTem)
// ============================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.post('/admin/buscar-empresa', async (req, res) => {
  const { senha, nome } = req.body;
  if (senha !== ADMIN_PASSWORD) return res.status(401).json({ erro: 'Senha incorreta.' });
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Digite um nome pra buscar.' });

  try {
    const { rows } = await pool.query(
      `SELECT id, empresa_nome, cargo, area, bairro, ativa
       FROM vagas
       WHERE unaccent(empresa_nome) ILIKE '%' || unaccent($1) || '%'
          OR similarity(unaccent(empresa_nome), unaccent($1)) > 0.3
       ORDER BY empresa_nome ASC
       LIMIT 15`,
      [nome.trim()]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar por nome (admin):', err);
    res.status(500).json({ erro: 'Erro no servidor.' });
  }
});

app.post('/admin/excluir', async (req, res) => {
  const { senha, id } = req.body;
  if (senha !== ADMIN_PASSWORD) return res.status(401).json({ erro: 'Senha incorreta.' });
  if (!id || isNaN(parseInt(id, 10))) return res.status(400).json({ erro: 'Número da vaga inválido.' });

  try {
    const result = await pool.query(`DELETE FROM vagas WHERE id = $1 RETURNING empresa_nome`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Nenhuma vaga encontrada com esse número.' });
    }
    res.json({ sucesso: true, nome: result.rows[0].empresa_nome });
  } catch (err) {
    console.error('Erro ao excluir (admin):', err);
    res.status(500).json({ erro: 'Erro no servidor.' });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Trampo Cláudio server rodando na porta ${PORT}`));