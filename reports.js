/**
 * EPIMELEIA V3.4 — Oracle Node · reports.js
 * ──────────────────────────────────────────
 * Generación y envío de reportes trimestrales por email — Ajuste 21.
 * Descarga de datos satelitales completos — Ajuste 20.
 * Alertas de saldo bajo y notificaciones webhook — Ajuste 5.
 */

const axios    = require('axios');
const { config } = require('./config');
const { log }    = require('./logger');

// ─── Reporte trimestral completo (Ajuste 21) ───────────────────

/**
 * Genera y envía el reporte de cierre trimestral al email corporativo registrado.
 * Se dispara automáticamente al cerrar cada Q (vía evento ReporteTrimestralTrigger).
 *
 * @param {Object} params
 * @param {number} params.activoId
 * @param {string} params.owner        - Wallet del dueño del activo
 * @param {number} params.trimestre    - Ej: 20241 = Q1 2024
 * @param {Object} params.datosBilling - Estado de billing
 * @param {Array}  params.certs        - Certificaciones del trimestre
 * @param {Array}  params.huecos       - Huecos del trimestre
 * @param {number} params.indiceCont   - Índice de continuidad (0-100)
 * @param {string} params.emailDestino - Email corporativo registrado
 * @param {string} params.nombreActivo - Nombre del activo
 */
async function enviarReporteTrimestral(params) {
  const {
    activoId, owner, trimestre, datosBilling,
    certs, huecos, indiceCont, emailDestino, nombreActivo
  } = params;

  const año  = Math.floor(trimestre / 10);
  const q    = trimestre % 10;
  const asunto = `[EPIMELEIA] Reporte Trimestral Q${q} ${año} — ${nombreActivo}`;

  const html = _generarHTMLReporte({
    activoId, owner, año, q, datosBilling,
    certs, huecos, indiceCont, nombreActivo
  });

  log('EMAIL', `Enviando reporte trimestral`, { activoId, trimestre, emailDestino });

  await _enviarEmail({ para: emailDestino, asunto, html });

  log('EMAIL', `Reporte Q${q}/${año} enviado`, { activoId, emailDestino });
}

/**
 * Genera el HTML del reporte trimestral — corporativo, explicado, completo.
 */
function _generarHTMLReporte({ activoId, owner, año, q, datosBilling, certs, huecos, indiceCont, nombreActivo }) {
  const estadoColor = indiceCont >= 75 ? '#1a4a1a' : indiceCont >= 50 ? '#8a6a1a' : '#7a2a1a';
  const estadoTexto = indiceCont >= 75 ? 'EXCELENTE' : indiceCont >= 50 ? 'REGULAR' : 'CRÍTICO';

  const filaCerts = certs.map(c => `
    <tr>
      <td style="padding:8px;border:1px solid #ddd;font-family:monospace;font-size:12px;">${c.satelite}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:12px;">${c.bandaEspectral}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:12px;">${c.nubosidadPct}%</td>
      <td style="padding:8px;border:1px solid #ddd;font-family:monospace;font-size:11px;">${c.hashEvidencia?.slice(0,16)}...</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:11px;">${new Date(c.timestamp * 1000).toLocaleDateString('es-AR')}</td>
      <td style="padding:8px;border:1px solid #ddd;">
        ${c.urlDescargaDatos
          ? `<a href="${c.urlDescargaDatos}" style="color:#1a4a1a;font-size:11px;">⬇ DESCARGAR</a>`
          : '—'}
      </td>
    </tr>`).join('');

  const filaHuecos = huecos.map(h => `
    <tr>
      <td style="padding:8px;border:1px solid #fdd;font-size:12px;color:#7a2a1a;">${h.causa}</td>
      <td style="padding:8px;border:1px solid #fdd;font-size:12px;">${h.esCausaClimatica ? '🌧 Climática' : '⚠ Técnica/Humana'}</td>
      <td style="padding:8px;border:1px solid #fdd;font-size:11px;">${new Date(h.timestamp * 1000).toLocaleDateString('es-AR')}</td>
    </tr>`).join('');

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f0e8;font-family:'Georgia',serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0e8;padding:40px 20px;">
<tr><td>
<table width="600" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#ffffff;border:1px solid #ddd;">

  <!-- HEADER -->
  <tr>
    <td style="background:#0f1a0f;padding:32px 40px;">
      <div style="font-family:'Georgia',serif;font-size:24px;letter-spacing:4px;color:#f4f0e8;">EPIMELEIA</div>
      <div style="font-family:monospace;font-size:10px;color:#8a9e8a;letter-spacing:2px;margin-top:4px;">
        NOTARIO DIGITAL AMBIENTAL · POLYGON MAINNET · V3.4
      </div>
    </td>
  </tr>

  <!-- TÍTULO -->
  <tr>
    <td style="padding:32px 40px;border-bottom:1px solid #eee;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:3px;color:#8a9e8a;margin-bottom:8px;">
        REPORTE DE CIERRE TRIMESTRAL
      </div>
      <h1 style="font-size:28px;font-weight:300;color:#0f1a0f;margin:0 0 8px 0;">
        Q${q} ${año} — ${nombreActivo}
      </h1>
      <div style="font-family:monospace;font-size:11px;color:#5a6a5a;">
        Activo ID: ${activoId} &nbsp;·&nbsp; Wallet: ${owner?.slice(0,10)}...${owner?.slice(-6)}
      </div>
    </td>
  </tr>

  <!-- ÍNDICE DE CONTINUIDAD -->
  <tr>
    <td style="padding:24px 40px;background:#f9f9f7;border-bottom:1px solid #eee;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#8a9e8a;">ÍNDICE DE CONTINUIDAD</div>
            <div style="font-size:48px;font-weight:bold;color:${estadoColor};margin-top:4px;">${indiceCont}%</div>
            <div style="font-family:monospace;font-size:12px;color:${estadoColor};letter-spacing:1px;">${estadoTexto}</div>
          </td>
          <td style="text-align:right;vertical-align:top;">
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-bottom:4px;">CERTIFICACIONES Q</div>
            <div style="font-size:24px;color:#1a4a1a;font-weight:bold;">${certs.length}</div>
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-top:12px;margin-bottom:4px;">HUECOS DE OPACIDAD</div>
            <div style="font-size:24px;color:#7a2a1a;font-weight:bold;">${huecos.length}</div>
          </td>
        </tr>
      </table>
      <p style="font-size:12px;color:#5a6a5a;margin:16px 0 0 0;line-height:1.7;">
        El índice de continuidad representa el porcentaje de trimestres con certificación satelital exitosa
        sobre el total de trimestres transcurridos desde el registro. Es el indicador principal de
        consistencia ambiental de tu empresa ante terceros.
      </p>
    </td>
  </tr>

  <!-- CERTIFICACIONES -->
  ${certs.length > 0 ? `
  <tr>
    <td style="padding:24px 40px;border-bottom:1px solid #eee;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#8a9e8a;margin-bottom:16px;">
        CERTIFICACIONES SATELITALES DEL TRIMESTRE
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
        <tr style="background:#f0ece0;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">SATÉLITE</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">BANDA</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">NUBOSIDAD</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">HASH</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">FECHA</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">DATOS</th>
        </tr>
        ${filaCerts}
      </table>
      <p style="font-size:11px;color:#8a9e8a;margin-top:8px;font-family:monospace;">
        Cada hash de evidencia es el keccak256 del reporte satelital completo, grabado en Polygon Mainnet. Inalterable.
      </p>
    </td>
  </tr>` : ''}

  <!-- HUECOS -->
  ${huecos.length > 0 ? `
  <tr>
    <td style="padding:24px 40px;border-bottom:1px solid #eee;background:#fff8f8;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#7a2a1a;margin-bottom:16px;">
        HUECOS DE OPACIDAD REGISTRADOS
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
        <tr style="background:#fdd;">
          <th style="padding:8px;border:1px solid #fdd;text-align:left;font-family:monospace;font-size:10px;">CAUSA</th>
          <th style="padding:8px;border:1px solid #fdd;text-align:left;font-family:monospace;font-size:10px;">TIPO</th>
          <th style="padding:8px;border:1px solid #fdd;text-align:left;font-family:monospace;font-size:10px;">FECHA</th>
        </tr>
        ${filaHuecos}
      </table>
      <p style="font-size:11px;color:#7a2a1a;margin-top:8px;line-height:1.6;">
        Un Hueco de Opacidad no es una penalización. Es la verdad grabada permanentemente.
        Un hueco con causa climática acreditada no afecta la reputación de la empresa.
      </p>
    </td>
  </tr>` : ''}

  <!-- SALDO Y BILLING -->
  <tr>
    <td style="padding:24px 40px;border-bottom:1px solid #eee;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#8a9e8a;margin-bottom:12px;">ESTADO DE CUENTA</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:13px;color:#3a4a3a;padding:4px 0;">Saldo disponible:</td>
          <td style="font-family:monospace;font-size:13px;color:#1a4a1a;text-align:right;padding:4px 0;">
            ${datosBilling?.saldo || '—'} POL
          </td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#3a4a3a;padding:4px 0;">Próximo billing:</td>
          <td style="font-family:monospace;font-size:13px;color:#3a4a3a;text-align:right;padding:4px 0;">
            ${datosBilling?.diasHastaBilling != null ? `${datosBilling.diasHastaBilling} días` : '—'}
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="padding:24px 40px;background:#0f1a0f;">
      <p style="color:rgba(244,240,232,0.6);font-size:11px;font-family:monospace;margin:0;line-height:1.8;">
        Este reporte fue generado automáticamente por el protocolo EPIMELEIA V3.4.<br>
        Contrato activo en Polygon Mainnet. Datos verificables públicamente en blockchain.<br>
        Consultas: <a href="mailto:info@epimeleia.world" style="color:#4a7c4a;">info@epimeleia.world</a>
        &nbsp;·&nbsp; <a href="https://epimeleia.world" style="color:#4a7c4a;">epimeleia.world</a>
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Alerta de saldo bajo (Ajuste 5) ───────────────────────────

async function enviarAlertaSaldo(params) {
  const { activoId, owner, emailDestino, nombreActivo, saldoPOL, feeProximo, diasRestantes } = params;

  const asunto = `[EPIMELEIA] ⚠ Saldo bajo — ${nombreActivo} · Recargá antes de ${diasRestantes} días`;

  const html = `
  <div style="font-family:Georgia,serif;max-width:500px;margin:0 auto;background:#f4f0e8;padding:32px;">
    <div style="font-size:20px;letter-spacing:3px;color:#0f1a0f;margin-bottom:16px;">EPIMELEIA</div>
    <h2 style="font-size:20px;font-weight:400;color:#7a2a1a;margin-bottom:16px;">⚠ Alerta: Saldo insuficiente</h2>
    <p style="font-size:14px;color:#3a4a3a;line-height:1.7;">
      El activo <strong>${nombreActivo}</strong> (ID: ${activoId}) no tiene saldo suficiente
      para el próximo ciclo de certificación trimestral.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:13px;">
      <tr><td style="padding:8px;border:1px solid #ddd;">Saldo actual</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;color:#7a2a1a;">${saldoPOL} POL</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Fee requerido</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;">${feeProximo} POL</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Días para actuar</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;color:#8a6a1a;">${diasRestantes} días</td></tr>
    </table>
    <p style="font-size:13px;color:#5a6a5a;line-height:1.7;">
      Si no recargás saldo dentro de los <strong>7 días de gracia</strong> a partir del vencimiento,
      el activo quedará con un <strong>Hueco de Opacidad</strong> registrado permanentemente en blockchain.
      El activo no se cancela — se preserva con el historial completo.
    </p>
    <p style="font-size:11px;color:#8a9e8a;margin-top:16px;font-family:monospace;">
      Recargá en: epimeleia.world · Consultas: info@epimeleia.world
    </p>
  </div>`;

  log('EMAIL', `Enviando alerta de saldo bajo`, { activoId, emailDestino, diasRestantes });
  await _enviarEmail({ para: emailDestino, asunto, html });
}

// ─── Webhook admin ─────────────────────────────────────────────

async function notificarAdmin(evento, datos) {
  if (!config.notificaciones.webhookUrl) return;
  try {
    await axios.post(
      config.notificaciones.webhookUrl,
      {
        evento, datos,
        timestamp:  new Date().toISOString(),
        red:        'POLYGON_MAINNET',
        protocolo:  'EPIMELEIA_V3.4',
      },
      { timeout: config.notificaciones.timeoutWebhook }
    );
    log('WEBHOOK', `Notificación enviada: ${evento}`);
  } catch (err) {
    log('ERROR', `Webhook fallido: ${err.message}`);
  }
}

// ─── Email via SendGrid ────────────────────────────────────────

async function _enviarEmail({ para, asunto, html }) {
  if (!config.notificaciones.sendgridKey) {
    log('EMAIL', `MOCK (SendGrid no configurado): ${asunto} → ${para}`);
    return;
  }

  try {
    await axios.post(
      'https://api.sendgrid.com/v3/mail/send',
      {
        personalizations: [{ to: [{ email: para }] }],
        from:    { email: config.notificaciones.sendgridFrom, name: 'EPIMELEIA Protocol' },
        subject: asunto,
        content: [{ type: 'text/html', value: html }],
      },
      {
        headers: {
          'Authorization': `Bearer ${config.notificaciones.sendgridKey}`,
          'Content-Type':  'application/json',
        },
        timeout: 10000,
      }
    );
    log('EMAIL', `Email enviado: ${asunto} → ${para}`);
  } catch (err) {
    log('ERROR', `Error enviando email: ${err.message}`);
  }
}

module.exports = {
  enviarReporteTrimestral,
  enviarAlertaSaldo,
  notificarAdmin,
};
