// grblHAL settings enumeration ($ES).
//
// grbl-settings-templates.js is a static list made for older grblHAL builds, so newer settings (backlash
// $160-$162, $485, $539, $676, $680, ...) showed up as ";unknown" in the log, the backup file and the save
// dialog, and as a bare red key in the Advanced Settings table. grblHAL can list every setting it has:
// the `$ES` command answers one line per setting, then "ok":
//
//   [SETTING:<id>|<group id>|<name>|{<unit>}|<data type>|{<format>}|{<min>}|{<max>}|{<reboot required>}|{<null allowed>}]
//   [SETTING:0|18|Step pulse time|microseconds|6|#0.0|2.0|]
//
// (grblHAL/core wiki, "Report-extensions"). This file asks for that list ONCE per connection and keeps it
// as a map id -> {name, unit, type, format, min, max, reboot}. The static templates stay the primary source
// (and the only one for older firmware); the map only fills what they do not know.
//
// SAFETY - `$ES` is sent ONLY when the firmware is grblHAL AND its `$I` answer lists ENUMS in
// [NEWOPT:...] (the token "ES" in that list means "E-stop signal", NOT extended settings). A controller
// that does not know `$ES` answers error:3, which puts the sender into its error state - so it is never
// asked: the check happens BEFORE sending, there is no send-then-handle-the-error. grblEnumRequest() is the
// one and only place that sends it.

var GRBL_ENUM_MAX_SETTINGS = 2000;
var GRBL_ENUM_MAX_TEXT = 200; // name, unit, min, max
var GRBL_ENUM_MAX_FORMAT = 4000; // the label list of a bit field / radio: it grows with the firmware, never cut it short

var grblEnum = grblEnumEmpty('');

function grblEnumEmpty(platform) {
  return {
    platform: platform, // the firmware platform of the CURRENT connection ('' = not connected)
    enums: false, // the $I answer listed ENUMS
    requested: false, // $ES was sent (once per connection)
    collecting: false, // between the $ES send and its "ok"
    done: false,
    settings: {}, // id (string) -> {id, group, name, unit, type, format, min, max, reboot, nullAllowed}
    count: 0
  };
}

// Called from showGrbl(): the platform of the connection (or '' on disconnect). A new connection, a
// different platform or a disconnect starts from scratch; the same platform announced again (a page
// reload / a second client) keeps what was read.
function grblEnumSetPlatform(platform) {
  platform = typeof platform === 'string' ? platform : '';
  if (grblEnum.platform !== platform) {
    grblEnum = grblEnumEmpty(platform);
  }
}

// [NEWOPT:ENUMS,RT+,ES,TC,SED] -> true. Exact token: "ES" alone is the e-stop signal, not this.
function grblEnumHasEnums(newoptLine) {
  if (typeof newoptLine !== 'string' || newoptLine.indexOf('[NEWOPT:') !== 0) return false;
  var end = newoptLine.indexOf(']');
  var list = newoptLine.substring('[NEWOPT:'.length, end === -1 ? newoptLine.length : end);
  var tokens = list.split(',');
  for (var i = 0; i < tokens.length; i++) {
    if (tokens[i].trim() === 'ENUMS') return true;
  }
  return false;
}

// The gate. Only a grblHAL connection whose $I answer said ENUMS, once per connection, and never from the
// phone jog page (the answer is broadcast to every client, one request is enough).
function grblEnumMaySend() {
  if (typeof isJogWidget !== 'undefined' && isJogWidget) return false;
  return grblEnum.platform === 'grblHAL' && grblEnum.enums === true && grblEnum.requested === false;
}

function grblEnumRequest() {
  if (!grblEnumMaySend()) return false;
  grblEnum.requested = true;
  grblEnum.collecting = true;
  sendGcode('$ES');
  return true;
}

function grblEnumClean(text, max) {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || GRBL_ENUM_MAX_TEXT);
}

// One [SETTING:...] line -> object, or null when it is not a usable setting line.
// Forward compatible, as the grblHAL sender guide asks: fields are read by position and any EXTRA fields at
// the end are ignored; an unknown data type code just means "plain input"; the comma separated label lists
// (format) are kept whole because they get more entries over time.
function grblEnumParseSetting(line) {
  if (typeof line !== 'string' || line.indexOf('[SETTING:') !== 0) return null;
  var end = line.lastIndexOf(']');
  var body = line.substring('[SETTING:'.length, end > 0 ? end : line.length);
  var f = body.split('|');
  if (!/^\d{1,5}$/.test(f[0].trim())) return null;
  var type = /^\d$/.test((f[4] || '').trim()) ? parseInt(f[4], 10) : null;
  return {
    id: parseInt(f[0], 10),
    group: /^\d{1,4}$/.test((f[1] || '').trim()) ? parseInt(f[1], 10) : null,
    name: grblEnumClean(f[2] || ''),
    unit: grblEnumClean(f[3] || ''),
    type: type,
    format: grblEnumClean(f[5] || '', GRBL_ENUM_MAX_FORMAT),
    min: grblEnumClean(f[6] || ''),
    max: grblEnumClean(f[7] || ''),
    reboot: (f[8] || '').trim() === '1',
    nullAllowed: (f[9] || '').trim() === '1'
  };
}

// Every 'data' event from the server passes here first (websocket.js). Returns true when the line was
// consumed - the raw protocol lines of OUR $ES request are not shown in the console.
function grblEnumHandleData(data) {
  if (!data || typeof data.response !== 'string') return false;
  var resp = data.response;

  if (resp.indexOf('[NEWOPT:') === 0) {
    grblEnum.enums = grblEnumHasEnums(resp);
    grblEnumRequest();
    return false; // the $I answer is still shown as before
  }

  if (grblEnum.collecting && data.command === '$ES') {
    if (resp.indexOf('[SETTING:') === 0) {
      var s = grblEnumParseSetting(resp);
      if (s && grblEnum.count < GRBL_ENUM_MAX_SETTINGS) {
        grblEnum.settings[String(s.id)] = s;
        grblEnum.count++;
      }
      return true;
    }
    if (resp === 'ok') {
      grblEnum.collecting = false;
      grblEnum.done = true;
      if (typeof printLogModern === 'function') {
        printLogModern('', '$ES', 'Read ' + grblEnum.count + ' setting definitions from the controller', 'fg-dark');
      }
      grblEnumOnDone();
      return true;
    }
    if (resp.indexOf('error') === 0) {
      grblEnum.collecting = false; // no map; the error is shown as usual
      return false;
    }
    if (resp.charAt(0) === '[') {
      return true; // a tag this version does not know: ignored, not printed
    }
  }
  return false;
}

// The Advanced Settings table was probably built before the answer arrived: rebuild it so the rows
// without a template get their names - but only when nothing in it has been edited (a rebuild would drop
// unsaved changes), and keep the tab the user is on.
function grblEnumOnDone() {
  if (typeof $ !== 'function' || typeof grblPopulate !== 'function') return;
  if (!$('#grblSettingsTable').length || !$('#saveBtn').attr('disabled')) return;
  var onAdvanced = $('#grbl-settings-advanced').is(':visible');
  grblPopulate();
  if (onAdvanced) $('#grblSettingsAdvTab').click();
}

function grblEnumEsc(text) {
  return String(text).replace(/[&<>"']/g, function(ch) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    } [ch];
  });
}

// The name of a setting: the static template's title first, then the controller's own name, else "unknown".
// asHtml: the result goes into HTML (log, dialog) - the controller's text is escaped, the template titles
// are trusted and stay as they were. For plain text (the backup file) leave it false.
function grblSettingName(key2, asHtml) {
  var t = grblSettingsTemplate2[key2];
  if (t !== undefined) return t.title;
  var e = grblEnum.settings[String(key2)];
  if (e && e.name) return asHtml ? grblEnumEsc(e.name) : e.name;
  return 'unknown';
}

// Labels of a comma separated format list, with their index; "N/A" entries are for unavailable bits/options.
function grblEnumLabels(format) {
  var out = [];
  var parts = String(format).split(',');
  for (var i = 0; i < parts.length; i++) {
    var label = parts[i].trim();
    if (label !== '' && label !== 'N/A') out.push({ index: i, label: label });
  }
  return out;
}

// A short human hint for the value column, from the data type.
function grblEnumHint(e) {
  var labels;
  switch (e.type) {
    case 0:
      return '0 = off, 1 = on';
    case 1:
    case 2:
      labels = grblEnumLabels(e.format).map(function(l) {
        return 'bit ' + l.index + ' = ' + l.label;
      });
      return (labels.length ? labels.join(', ') : 'bit field') + (e.type === 2 ? ' (bit 0 must be set to use the others)' : '');
    case 3:
      labels = grblEnumLabels(e.format).map(function(l) {
        return l.index + ' = ' + l.label;
      });
      return labels.length ? labels.join(', ') : 'one of a list of options';
    case 4:
      return 'axis mask: bit 0 = X, bit 1 = Y, bit 2 = Z, ...';
    case 5:
    case 6:
      if (e.min !== '' && e.max !== '') return 'range ' + e.min + ' to ' + e.max;
      if (e.min !== '') return 'minimum ' + e.min;
      if (e.max !== '') return 'maximum ' + e.max;
      return '';
    case 7:
      return (/^x\((\d+)\)$/.exec(e.format) ? 'text, up to ' + /^x\((\d+)\)$/.exec(e.format)[1] + ' characters' : 'text');
    case 8:
      return 'password';
    case 9:
      return 'IPv4 address, e.g. 192.168.0.10';
  }
  return '';
}

// One <tr> of the Advanced Settings table for a setting the static templates do not have. With no
// definition from the controller it is exactly the row the panel always showed (red key, plain input).
// The input keeps the id convention val-<n>-input, so change detection and Save work unchanged.
function grblEnumRowHtml(key, key2, value) {
  var e = grblEnum.settings[String(key2)];
  var v = grblEnumEsc(value);
  if (!e) {
    return '<tr>' +
      '<td>' + grblEnumEsc(key) + '</td>' +
      '<td><span class="tally alert">' + grblEnumEsc(key) + '</span></td>' +
      '<td><input data-role="input" data-clear-button="false" data-append="?" type="text" value="' + v + '" id="val-' + grblEnumEsc(key2) + '-input"></td>' +
      '<td></td>' +
      '</tr>';
  }
  var hint = grblEnumHint(e);
  var notes = [];
  if (hint) notes.push(hint);
  if (e.reboot) notes.push('restart the controller after saving');
  var tip = key + ' - ' + (e.name || 'setting') + (notes.length ? ' (' + notes.join('; ') + ')' : '');
  return '<tr id="grblSettingsRow' + grblEnumEsc(key2) + '" title="' + grblEnumEsc(tip) + '">' +
    '<td>' + grblEnumEsc(key) + '</td>' +
    '<td>' + grblEnumEsc(e.name || key) + (notes.length ? '<br><small class="fg-gray">' + grblEnumEsc(notes.join(' - ')) + '</small>' : '') + '</td>' +
    '<td><input data-role="input" data-clear-button="false" data-append="' + grblEnumEsc(e.unit || '') + '" type="' + (e.type === 8 ? 'password' : 'text') + '" value="' + v + '" id="val-' + grblEnumEsc(key2) + '-input"></td>' +
    '<td></td>' +
    '</tr>';
}
