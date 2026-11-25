/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* What index.html's buttons and switches do, as code of this file.
 *
 * They were onclick="…" and onchange="…" attributes, which a policy that refuses
 * code written into a page (script-src without 'unsafe-inline') cannot allow.
 * tools/extract-inline.cjs moved each one here and left data-on-click / data-on-change
 * on the element; they are bound below, to the element itself. A function is
 * resolved by name when it is pressed, from the global scope, as the attribute was.
 *
 * Markup the app writes later (a list it draws) has no attribute to move: it
 * carries data-call="name" data-args='[…]' and is handled at the end of this file. */
(function () {
  'use strict';
  var ACTIONS = {
  a1(event) { promptInstallApp(); },
  a2(event) { continueInBrowserExperience(); },
  a3(event) { selectLanguage('fa'); },
  a4(event) { selectLanguage('en'); },
  a5(event) { triggerPanic(); },
  a6(event) { toggleVirtualKeyboard('setupPassword'); },
  a7(event) { togglePasswordVisibility('setupPassword', this); },
  a8(event) { toggleVirtualKeyboard('confirmPassword'); },
  a9(event) { togglePasswordVisibility('confirmPassword', this); },
  a10(event) { updateSecQuestions(); },
  a11(event) { toggleSetupLegalDisclosure(); },
  a12(event) { setupMasterPassword(); },
  a13(event) { goBackToLang(); },
  a14(event) { toggleVirtualKeyboard('unlockPassword'); },
  a15(event) { togglePasswordVisibility('unlockPassword', this); },
  a16(event) { unlockApp(); },
  a17(event) { unlockWithPasskey(); },
  a18(event) { showResetPassword(); },
  a19(event) { toggleVirtualKeyboard('resetNewPassword'); },
  a20(event) { toggleVirtualKeyboard('resetConfirmPassword'); },
  a21(event) { verifySecurityQuestions(); },
  a22(event) { setNewMasterPasswordFromReset(); },
  a23(event) { hideResetPassword(); },
  a24(event) { switchLanguage(); },
  a25(event) { toggleTheme(); },
  a26(event) { lockApp(); },
  a27(event) { switchTab('securitycenter'); },
  a28(event) { switchTab('chat'); },
  a29(event) { switchTab('vault'); },
  a30(event) { switchTab('locallink'); },
  a31(event) { switchTab('migration'); },
  a32(event) { switchTab('settings'); },
  a33(event) { switchTab('help'); },
  a34(event) { switchTab('about'); },
  a35(event) { renderSecurityCenter(); },
  a36(event) { togglePasswordVisibility('panicPasswordInput_sc', this); },
  a37(event) { setPanicPassword('panicPasswordInput_sc'); },
  a38(event) { copyChatFullIdentity(); },
  a39(event) { openPackManager(); },
  a40(event) { toggleVirtualKeyboard('exportPassword'); },
  a41(event) { exportMigrationData(); },
  a42(event) { document.getElementById('importFileName').textContent = this.files[0]?.name || ''; },
  a43(event) { document.getElementById('importMigrationFile').click(); },
  a44(event) { toggleVirtualKeyboard('importPassword'); },
  a45(event) { importMigrationData(); },
  a46(event) { toggleNativeShellDiag(); },
  a47(event) { saveSettings(); },
  a48(event) { toggleAutoLock(); },
  a49(event) { toggleCustomAutoLockTime(); },
  a50(event) { showChangePassword(); },
  a51(event) { toggleVirtualKeyboard('currentPassword'); },
  a52(event) { toggleVirtualKeyboard('newPassword'); },
  a53(event) { toggleVirtualKeyboard('confirmNewPassword'); },
  a54(event) { changeMasterPassword(); },
  a55(event) { showChangeSecurityQuestions(); },
  a56(event) { toggleVirtualKeyboard('settingsSecurityPassword'); },
  a57(event) { updateSettingsSecurityQuestions(); },
  a58(event) { changeSecurityQuestions(); },
  a59(event) { toggle2FA(); },
  a60(event) { togglePasskeyQuickUnlock(); },
  a61(event) { applyAppearanceSettings(); },
  a62(event) { applyDesktopIconProfileSelection(); },
  a63(event) { setTheme('light'); },
  a64(event) { setTheme('dark'); },
  a65(event) { setTheme('pastel'); },
  a66(event) { setTheme('midnight'); },
  a67(event) { setTheme('neon'); },
  a68(event) { setTheme('dracula'); },
  a69(event) { setTheme('nord'); },
  a70(event) { setTheme('solarized'); },
  a71(event) { setTheme('cyberpunk'); },
  a72(event) { setTheme('ocean'); },
  a73(event) { setTheme('forest'); },
  a74(event) { setTheme('aurora'); },
  a75(event) { setTheme('sunset'); },
  a76(event) { setTheme('linen'); },
  a77(event) { setTheme('obsidian'); },
  a78(event) { setTheme('custom'); },
  a79(event) { applyCustomTheme(); },
  a80(event) { handleNotificationsToggleChange(); },
  a81(event) { handlePushToggleChange(); },
  a82(event) { handlePushTtlChange(); },
  a83(event) { connectUnifiedPush(); },
  a84(event) { disconnectUnifiedPush(); },
  a85(event) { toggleMailPolling(this.checked); },
  a86(event) { handleDesktopKeepRunningChange(); },
  a87(event) { handleDesktopAutostartChange(); },
  a88(event) { handleDesktopStartMinimizedChange(); },
  a89(event) { handleDesktopVaultSyncChange(); },
  a90(event) { saveDesktopVaultSnapshotNow(); },
  a91(event) { deleteDesktopVaultSnapshot(); },
  a92(event) { resetTabOrder(); },
  a93(event) { togglePasswordVisibility('panicPasswordInput_dz', this); },
  a94(event) { setPanicPassword('panicPasswordInput_dz'); },
  a95(event) { resetAppSettings(); },
  a96(event) { checkForUpdatesNow(); },
  a97(event) { setUpdateAutoCheck(this.checked); },
  a98(event) { closeInstallGuideModal(); },
  a99(event) { toggleKeyboardShift(); },
  a100(event) { backspaceKeyboardInput(); },
  a101(event) { clearKeyboardInput(); },
  a102(event) { toggleVirtualKeyboard(); },
  a103(event) { verifySettings2FA(); },
  a104(event) { closeSettings2FA(); },
  a105(event) { toggleVirtualKeyboard('viewPasswordInput'); },
  a106(event) { submitViewPassword(); },
  a107(event) { biometricViewPassword(); },
  a108(event) { closeViewPasswordModal(); },
  a109(event) { copyRevealedPassword(); },
  a110(event) { dismissDesktopBiometricPrompt(); },
  a111(event) { enableDesktopBiometricFromPrompt(); },
  };

  function run(element, event, id) {
    var action = ACTIONS[id];
    if (!action) return;
    var result = action.call(element, event);
    if (result === false) event.preventDefault();
  }
  ['click', 'change'].forEach(function (kind) {
    document.querySelectorAll('[data-on-' + kind + ']').forEach(function (element) {
      element.addEventListener(kind, function (event) { run(element, event, element.getAttribute('data-on-' + kind)); });
    });
  });
  document.querySelectorAll('link[data-as-stylesheet]').forEach(function (link) { link.rel = 'stylesheet'; });

  /* Markup drawn at run time: a function of the app, by name, with arguments. Only
     names listed here can be called, so a piece of markup that carries somebody
     else's text cannot name anything else. */
  var CALLS = ['handleTabOrderDragStart', 'handleTabOrderDragOver', 'handleTabOrderDragLeave', 'handleTabOrderDrop', 'handleTabOrderDragEnd', 'moveTabOrder', 'viewPassword', 'copyPassword', 'deletePassword', 'switchTab', 'moveMobileTabBarItem', 'toggleMobileTabBarItem'];
  function delegated(kind) {
    return function (event) {
      var element = event.target && event.target.closest ? event.target.closest('[data-call-' + kind + ']') : null;
      if (!element || element.disabled) return;
      var name = element.getAttribute('data-call-' + kind);
      if (CALLS.indexOf(name) < 0 || typeof window[name] !== 'function') return;
      var args = [];
      try { args = JSON.parse(element.getAttribute('data-args') || '[]'); } catch (error) { return; }
      args = Array.isArray(args) ? args : [];
      /* A drag handler is given the event first, as the attribute gave it. */
      if (kind.indexOf('drag') === 0 || kind === 'drop') args = [event].concat(args);
      window[name].apply(window, args);
    };
  }
  ['click', 'change', 'dragstart', 'dragover', 'dragleave', 'drop', 'dragend'].forEach(function (kind) {
    document.addEventListener(kind, delegated(kind));
  });
})();
