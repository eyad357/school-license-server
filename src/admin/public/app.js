'use strict';

const state = {
  token: sessionStorage.getItem('admin_token') || '',
  licenses: [],
};

const $ = (id) => document.getElementById(id);

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('dashboardView').classList.add('hidden');
}

function showDashboard() {
  $('loginView').classList.add('hidden');
  $('dashboardView').classList.remove('hidden');
}

function message(id, text = '', type = '') {
  const el = $(id);

  if (!el) {
    return;
  }

  el.textContent = text;
  el.className = `message ${type}`.trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) {
    return 'بدون انتهاء';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'غير معروف';
  }

  return date.toLocaleDateString('ar-EG');
}

function statusBadge(status) {
  switch (status) {
    case 'ACTIVE':
      return '<span class="badge active">نشط</span>';

    case 'REVOKED':
      return '<span class="badge revoked">ملغى</span>';

    case 'EXPIRED':
      return '<span class="badge expired">منتهي</span>';

    default:
      return `<span class="badge inactive">${escapeHtml(status)}</span>`;
  }
}

async function login(username, password) {
  const response = await fetch('/api/v1/admin/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username,
      password,
    }),
  });

  let data;

  try {
    data = await response.json();
  } catch (_error) {
    throw new Error('استجابة غير صالحة من الخادم.');
  }

  if (!response.ok || !data.token) {
    throw new Error(
      data.message || 'فشل تسجيل الدخول.'
    );
  }

  state.token = data.token;

  sessionStorage.setItem(
    'admin_token',
    data.token
  );

  showDashboard();

  await loadLicenses();
}

function logout() {
  state.token = '';
  state.licenses = [];

  sessionStorage.removeItem('admin_token');

  showLogin();
}

async function api(path, options = {}) {
  const response = await fetch(
    `/api/v1/admin${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    }
  );

  let data;

  try {
    data = await response.json();
  } catch (_error) {
    throw new Error('استجابة غير صالحة من الخادم.');
  }

  if (response.status === 401) {
    logout();
    throw new Error('انتهت جلسة الإدارة.');
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
      `فشل الطلب (${response.status}).`
    );
  }

  return data;
}

function renderStats() {
  $('totalCount').textContent =
    state.licenses.length;

  $('activeCount').textContent =
    state.licenses.filter(
      (license) => license.status === 'ACTIVE'
    ).length;

  $('revokedCount').textContent =
    state.licenses.filter(
      (license) => license.status === 'REVOKED'
    ).length;

  $('expiredCount').textContent =
    state.licenses.filter(
      (license) => license.status === 'EXPIRED'
    ).length;
}

function renderLicenses() {
  const query =
    $('searchInput').value.trim().toLowerCase();

  const rows = state.licenses.filter((license) => {
    const searchableText = [
      license.license_key,
      license.customer_name,
      license.customer_email,
      license.product_id,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return searchableText.includes(query);
  });

  const body = $('licensesTableBody');

  if (!rows.length) {
    body.innerHTML = `
      <tr>
        <td colspan="7">
          لا توجد تراخيص.
        </td>
      </tr>
    `;

    return;
  }

  body.innerHTML = rows
    .map((license) => {
      const actionButton =
        license.status === 'ACTIVE'
          ? `
            <button
              class="danger"
              type="button"
              data-action="revoke"
              data-id="${license.id}">
              إلغاء
            </button>
          `
          : `
            <button
              class="success"
              type="button"
              data-action="reactivate"
              data-id="${license.id}">
              تفعيل
            </button>
          `;

      return `
        <tr>

          <td>
            <strong>
              ${escapeHtml(
                license.customer_name ||
                'بدون عميل'
              )}
            </strong>

            <div class="muted">
              ${escapeHtml(
                license.customer_email || ''
              )}
            </div>
          </td>

          <td>
            <div class="key-cell">

              <span class="key">
                ${escapeHtml(
                  license.license_key
                )}
              </span>

              <button
                class="copy-btn"
                type="button"
                data-copy="${escapeHtml(
                  license.license_key
                )}">
                نسخ
              </button>

            </div>
          </td>

          <td>
            ${statusBadge(license.status)}
          </td>

          <td>
            ${escapeHtml(
              license.active_devices
            )}
            /
            ${escapeHtml(
              license.max_devices
            )}
          </td>

          <td>
            ${escapeHtml(
              license.plan || 'lifetime'
            )}
          </td>

          <td>
            ${formatDate(
              license.expires_at
            )}
          </td>

          <td>
            <div class="actions">

              <button
                class="secondary"
                type="button"
                data-action="devices"
                data-id="${license.id}">
                الأجهزة
              </button>

              <button
                class="secondary"
                type="button"
                data-action="edit"
                data-id="${license.id}">
                تعديل
              </button>

              ${actionButton}

              <button
                class="danger"
                type="button"
                data-action="delete"
                data-id="${license.id}">
                حذف
              </button>

            </div>
          </td>

        </tr>
      `;
    })
    .join('');
}

async function loadLicenses() {
  message(
    'tableMessage',
    'جارٍ تحميل التراخيص...',
    'info'
  );

  try {
    const data = await api('/licenses');

    state.licenses =
      Array.isArray(data.licenses)
        ? data.licenses
        : [];

    renderStats();
    renderLicenses();

    message('tableMessage');
  } catch (error) {
    message(
      'tableMessage',
      error.message,
      'error'
    );
  }
}

async function createLicense() {
  const customerName =
    $('customerName').value.trim();

  const customerEmail =
    $('customerEmail').value.trim();

  const plan =
    $('plan').value.trim() || 'pro';

  const maxDevices =
    Number($('maxDevices').value);

  // The dropdown only ever offers these four fixed values. The server is
  // the sole authority on the resulting expires_at date — no expiration is
  // calculated in the browser.
  const duration =
    $('duration').value;

  if (!customerName) {
    message(
      'createMessage',
      'يرجى إدخال اسم العميل.',
      'error'
    );
    return;
  }

  if (
    !Number.isInteger(maxDevices) ||
    maxDevices < 1
  ) {
    message(
      'createMessage',
      'عدد الأجهزة يجب أن يكون 1 أو أكثر.',
      'error'
    );
    return;
  }

  message(
    'createMessage',
    'جارٍ إنشاء الترخيص...',
    'info'
  );

  try {
    const data = await api(
      '/licenses',
      {
        method: 'POST',
        body: JSON.stringify({
          customer: {
            name: customerName,
            email: customerEmail || null,
          },
          productId:
            'school-accreditation',
          maxDevices,
          duration,
          plan,
        }),
      }
    );

    const key =
      data.license.license_key;

    message(
      'createMessage',
      `تم إنشاء الترخيص: ${key}`,
      'success'
    );

    $('createLicenseForm').reset();

    $('plan').value = 'pro';
    $('maxDevices').value = '1';
    $('duration').value = 'lifetime';

    await loadLicenses();
  } catch (error) {
    message(
      'createMessage',
      error.message,
      'error'
    );
  }
}

async function revokeLicense(id) {
  if (
    !confirm(
      'هل أنت متأكد من إلغاء هذا الترخيص؟'
    )
  ) {
    return;
  }

  try {
    await api(
      `/licenses/${id}/revoke`,
      {
        method: 'POST',
      }
    );

    await loadLicenses();
  } catch (error) {
    alert(error.message);
  }
}

async function reactivateLicense(id) {
  if (
    !confirm(
      'هل تريد إعادة تفعيل هذا الترخيص؟'
    )
  ) {
    return;
  }

  try {
    await api(
      `/licenses/${id}/reactivate`,
      {
        method: 'POST',
      }
    );

    await loadLicenses();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteLicense(id) {
  const license =
    state.licenses.find(
      (item) => item.id === id
    );

  const key =
    license?.license_key ||
    'هذا الترخيص';

  const confirmed = confirm(
    `تحذير!\n\n` +
    `سيتم حذف الترخيص نهائيًا:\n\n` +
    `${key}\n\n` +
    `سيتم حذف ارتباطات الأجهزة أيضًا.\n` +
    `لا يمكن التراجع عن هذه العملية.\n\n` +
    `هل أنت متأكد؟`
  );

  if (!confirmed) {
    return;
  }

  try {
    await api(
      `/licenses/${id}`,
      {
        method: 'DELETE',
      }
    );

    await loadLicenses();

    alert(
      'تم حذف الترخيص نهائيًا.'
    );
  } catch (error) {
    alert(
      `فشل حذف الترخيص: ${error.message}`
    );
  }
}

function openEditLicense(id) {
  const license =
    state.licenses.find(
      (item) => item.id === id
    );

  if (!license) {
    return;
  }

  $('editLicenseId').value =
    license.id;

  $('editLicenseKey').textContent =
    license.license_key;

  $('editMaxDevices').value =
    license.max_devices;

  $('editPlan').value =
    license.plan || 'pro';

  // Show the license's current effective expiration/duration state as
  // read-only info, and always leave the duration selector on "no change"
  // so opening the edit form can never silently reset an expiration.
  const isExpired =
    license.expires_at &&
    new Date(license.expires_at).getTime() <= Date.now();

  $('editCurrentExpiration').textContent =
    license.expires_at
      ? `${formatDate(license.expires_at)}${isExpired ? ' (منتهي)' : ''}`
      : 'بدون انتهاء (Lifetime)';

  $('editDuration').value = '';

  message('editMessage');

  $('editModal')
    .classList
    .remove('hidden');
}

async function saveLicenseEdit() {
  const id =
    $('editLicenseId').value;

  const maxDevices =
    Number(
      $('editMaxDevices').value
    );

  const plan =
    $('editPlan').value.trim();

  // Empty string means "بدون تغيير" (no change) — the admin didn't pick a
  // new duration, so we omit it and the backend leaves expires_at as-is.
  const duration =
    $('editDuration').value;

  if (
    !Number.isInteger(maxDevices) ||
    maxDevices < 1
  ) {
    message(
      'editMessage',
      'عدد الأجهزة يجب أن يكون 1 أو أكثر.',
      'error'
    );

    return;
  }

  const body = {
    maxDevices,
    plan,
  };

  if (duration) {
    body.duration = duration;
  }

  message(
    'editMessage',
    'جارٍ حفظ التعديلات...',
    'info'
  );

  try {
    await api(
      `/licenses/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      }
    );

    message(
      'editMessage',
      'تم حفظ التعديلات.',
      'success'
    );

    await loadLicenses();

    setTimeout(() => {
      $('editModal')
        .classList
        .add('hidden');
    }, 500);
  } catch (error) {
    message(
      'editMessage',
      error.message,
      'error'
    );
  }
}

async function openDevices(licenseId) {
  const license =
    state.licenses.find(
      (item) => item.id === licenseId
    );

  $('devicesTitle').textContent =
    license
      ? `${license.license_key} — ${
          license.customer_name ||
          'بدون عميل'
        }`
      : '';

  $('devicesModal')
    .dataset
    .licenseId = licenseId;

  $('devicesTableBody').innerHTML = `
    <tr>
      <td colspan="5">
        جارٍ التحميل...
      </td>
    </tr>
  `;

  message('devicesMessage');

  $('devicesModal')
    .classList
    .remove('hidden');

  try {
    const data = await api(
      `/licenses/${licenseId}/devices`
    );

    if (!data.devices?.length) {
      $('devicesTableBody').innerHTML = `
        <tr>
          <td colspan="5">
            لا توجد أجهزة مسجلة.
          </td>
        </tr>
      `;

      return;
    }

    $('devicesTableBody').innerHTML =
      data.devices
        .map(
          (device, index) => `
            <tr>

              <td>
                الجهاز #${index + 1}
              </td>

              <td>
                ${formatDate(
                  device.activated_at
                )}
              </td>

              <td>
                ${formatDate(
                  device.last_seen_at
                )}
              </td>

              <td>
                ${
                  device.deactivated_at
                    ? '<span class="badge inactive">غير نشط</span>'
                    : '<span class="badge active">نشط</span>'
                }
              </td>

              <td>
                ${
                  device.deactivated_at
                    ? '-'
                    : `
                      <button
                        class="danger"
                        type="button"
                        data-action="reset-device"
                        data-id="${device.activation_id}">
                        Reset
                      </button>
                    `
                }
              </td>

            </tr>
          `
        )
        .join('');
  } catch (error) {
    message(
      'devicesMessage',
      error.message,
      'error'
    );
  }
}

async function resetDevice(activationId) {
  if (
    !confirm(
      'هل تريد عمل Reset لهذا الجهاز؟'
    )
  ) {
    return;
  }

  try {
    await api(
      `/licenses/${activationId}/reset-device`,
      {
        method: 'POST',
      }
    );

    const licenseId =
      $('devicesModal')
        .dataset
        .licenseId;

    await loadLicenses();
    await openDevices(licenseId);

    message(
      'devicesMessage',
      'تم عمل Reset للجهاز.',
      'success'
    );
  } catch (error) {
    message(
      'devicesMessage',
      error.message,
      'error'
    );
  }
}

$('loginForm').addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();

    message(
      'loginMessage',
      'جارٍ تسجيل الدخول...',
      'info'
    );

    try {
      await login(
        $('username').value.trim(),
        $('password').value
      );
    } catch (error) {
      message(
        'loginMessage',
        error.message,
        'error'
      );
    }
  }
);

$('logoutBtn').addEventListener(
  'click',
  logout
);

$('refreshBtn').addEventListener(
  'click',
  loadLicenses
);

$('searchInput').addEventListener(
  'input',
  renderLicenses
);

$('createLicenseBtn').addEventListener(
  'click',
  () => {
    message('createMessage');

    $('createModal')
      .classList
      .remove('hidden');
  }
);

$('createLicenseForm').addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();

    await createLicense();
  }
);

$('editLicenseForm').addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();

    await saveLicenseEdit();
  }
);

document.addEventListener(
  'click',
  async (event) => {
    const copyValue =
      event.target.dataset.copy;

    if (copyValue) {
      try {
        await navigator.clipboard.writeText(
          copyValue
        );

        const original =
          event.target.textContent;

        event.target.textContent =
          'تم النسخ';

        setTimeout(() => {
          event.target.textContent =
            original;
        }, 1200);
      } catch (_error) {
        alert(
          'تعذر نسخ المفتاح.'
        );
      }

      return;
    }

    const action =
      event.target.dataset.action;

    const id =
      event.target.dataset.id;

    if (!action || !id) {
      return;
    }

    if (action === 'devices') {
      await openDevices(id);
      return;
    }

    if (action === 'edit') {
      openEditLicense(id);
      return;
    }

    if (action === 'revoke') {
      await revokeLicense(id);
      return;
    }

    if (action === 'reactivate') {
      await reactivateLicense(id);
      return;
    }

    if (action === 'delete') {
      await deleteLicense(id);
      return;
    }

    if (action === 'reset-device') {
      await resetDevice(id);
    }
  }
);

document
  .querySelectorAll('[data-close]')
  .forEach((button) => {
    button.addEventListener(
      'click',
      () => {
        const modalId =
          button.dataset.close;

        $(modalId)
          .classList
          .add('hidden');
      }
    );
  });

if (state.token) {
  showDashboard();

  loadLicenses().catch(() => {
    logout();
  });
} else {
  showLogin();
}
