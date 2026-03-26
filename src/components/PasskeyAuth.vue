<template>
  <div class="q-gutter-md">
    <!-- Step 1: Choose action -->
    <div v-if="currentStep === 'choose'">
      <q-btn
        label="Sign in with Passkey"
        color="primary"
        icon="login"
        class="full-width q-mb-md"
        @click="startSignInFlow"
      />
      <q-btn
        label="Create New Passkey"
        color="secondary"
        icon="person_add"
        class="full-width"
        @click="startRegistrationFlow"
      />
      <p class="text-caption text-grey-7 q-mt-sm q-mb-none">
        No Touch ID? You can create or sign in with a passkey on your smartphone when prompted.
      </p>
    </div>

    <!-- Step 2: User ID Input -->
    <div v-if="currentStep === 'userId'">
      <q-input
        ref="userIdInputRef"
        v-model="userId"
        label="User ID"
        outlined
        :readonly="!!props.prefillUserId"
        :disable="!!props.prefillUserId"
        :rules="[
          (val) => !!val || 'User ID is required',
          (val) => val.length >= 3 || 'User ID must be at least 3 characters',
          (val) => val.length <= 20 || 'User ID must be 20 characters or less',
          (val) => /^[a-z0-9-]+$/.test(val) || 'User ID must contain only lowercase letters, numbers, and hyphens',
          (val) => !val.startsWith('-') && !val.endsWith('-') || 'User ID cannot start or end with a hyphen',
        ]"
        hint="3-20 characters: lowercase letters, numbers, hyphens only"
        @keyup.enter="handleEnterKey"
        class="q-mb-md"
      />
      <q-input
        v-if="adminSecretRequired"
        v-model="adminSecret"
        label="Admin Secret"
        outlined
        type="password"
        :rules="[(val) => !!val || 'Admin secret is required']"
        hint="Required to update the admin passkey"
        class="q-mb-md"
        @keyup.enter="handleEnterKey"
      />
      <div class="row q-gutter-sm q-mt-md">
        <q-btn
          label="Continue"
          color="primary"
          :loading="loading"
          :disable="!userId || userId.length < 3 || (adminSecretRequired && !adminSecret)"
          @click="continueAction"
        />
        <q-btn
          label="Back"
          flat
          @click="resetFlow"
        />
      </div>
    </div>

    <!-- Step 3: Registration/Authentication -->
    <div v-if="currentStep === 'registering' || currentStep === 'authenticating'">
      <div class="text-center q-mb-md">
        <q-spinner color="primary" size="3em" />
        <p class="q-mt-md">
          {{ currentStep === 'registering' ? 'Please complete passkey registration...' : 'Please complete passkey authentication...' }}
        </p>
      </div>
      <q-btn label="Cancel" flat @click="cancelFlow" />
    </div>


    <!-- Error message -->
    <q-banner
      v-if="error"
      dense
      rounded
      class="bg-red-1 text-red-8 q-mt-md"
    >
      {{ error }}
    </q-banner>
  </div>

  <!-- File Import Dialog - Step 1: Choose file -->
  <q-dialog v-model="showFileImportDialog" persistent>
    <q-card style="min-width: 400px; max-width: 500px">
      <q-card-section>
        <div class="text-h6">Import Initial Health Record</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <p class="text-body2">
          If you have an Apple Health Export PDF file or another initial health record file, import it for your initial knowledge base. You will be able to add other health records files later, at any time.
        </p>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <input
          ref="fileInputRef"
          type="file"
          accept=".pdf,.txt,.md"
          style="display: none"
          @change="handleFileSelected"
        />
        <q-btn
          label="CHOOSE FILE"
          color="primary"
          class="full-width"
          @click="triggerFileInput"
          :loading="uploadingFile"
        />
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" @click="handleFileImportCancel" />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <!-- File Import Dialog - Step 2: Confirm without file -->
  <q-dialog v-model="showConfirmWithoutFileDialog" persistent>
    <q-card style="min-width: 400px; max-width: 500px">
      <q-card-section>
        <div class="text-h6">Continue Without File</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <p class="text-body2">
          You can request a private AI without including a file. You will be able to add health records using Import (the paper clip) and the Saved Files tab in MyStuff at a later time.
        </p>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="I WANT TO ADD A FILE" @click="goBackToFileChooser" />
        <q-btn label="SEND SUPPORT REQUEST ANYWAY" color="primary" @click="sendRequestWithoutFile" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue';
import { startRegistration } from '@simplewebauthn/browser';
import { startAuthentication } from '@simplewebauthn/browser';

const props = defineProps<{
  prefillUserId?: string | null;
  prefillAction?: 'signin' | 'register' | null;
}>();

const emit = defineEmits(['authenticated', 'cancelled']);

const currentStep = ref('choose');
const userId = ref('');
const loading = ref(false);
const error = ref('');
const action = ref(''); // 'signin' or 'register'
const userIdInputRef = ref<HTMLInputElement | null>(null);
const adminSecret = ref('');
const adminSecretRequired = ref(false);
const showFileImportDialog = ref(false);
const showConfirmWithoutFileDialog = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploadingFile = ref(false);
const kbName = ref<string | null>(null);

const startSignInFlow = async () => {
  action.value = 'signin';
  currentStep.value = 'userId';
  await nextTick();
  userIdInputRef.value?.focus();
};

const startRegistrationFlow = async () => {
  action.value = 'register';
  currentStep.value = 'userId';
  await nextTick();
  userIdInputRef.value?.focus();
};

const resetFlow = () => {
  currentStep.value = 'choose';
  userId.value = '';
  error.value = '';
  action.value = '';
  loading.value = false;
  adminSecret.value = '';
  adminSecretRequired.value = false;
  showFileImportDialog.value = false;
  showConfirmWithoutFileDialog.value = false;
  kbName.value = null;
};

const cancelFlow = () => {
  resetFlow();
  emit('cancelled');
};

const applyPrefill = async (prefill: string | null | undefined) => {
  if (!prefill) return;
  userId.value = prefill;
  action.value = props.prefillAction === 'register' ? 'register' : 'signin';
  currentStep.value = 'userId';
  await nextTick();
  userIdInputRef.value?.focus();
  // Do not auto-call continueAction for register: user must click Continue so we can run
  // check-user and show the admin secret field first if needed.
  if (props.prefillAction === 'signin') {
    continueAction();
  }
};

watch(
  () => props.prefillUserId,
  (prefill) => {
    if (prefill) {
      applyPrefill(prefill);
    }
  },
  { immediate: true }
);

watch(userId, (next, prev) => {
  if (next && prev && next !== prev) {
    adminSecret.value = '';
    adminSecretRequired.value = false;
  }
});

const handleEnterKey = () => {
  if (userId.value && userId.value.length >= 3 && !loading.value) {
    continueAction();
  }
};

const continueAction = async () => {
  loading.value = true;
  error.value = '';

  try {
    if (action.value === 'register') {
      // Check if userId is available before proceeding
      const checkResponse = await fetch(`/api/passkey/check-user?userId=${userId.value}`, {
        credentials: 'include'
      });
      
      if (!checkResponse.ok) {
        const errorData = await checkResponse.json();
        throw new Error(errorData.error || 'Failed to check user ID');
      }

      const checkData = await checkResponse.json();
      
      if (checkData.exists && checkData.hasPasskey && !checkData.isAdminUser) {
        throw new Error('This user ID already has a passkey. Please sign in instead.');
      }
      if (checkData.isAdminUser) {
        adminSecretRequired.value = true;
        // If admin secret not entered yet, stay on step so user can fill it and click Continue again
        if (!adminSecret.value?.trim()) {
          loading.value = false;
          return;
        }
      }

      await handleRegistration();
    } else {
      await handleSignIn();
    }
  } catch (err: any) {
    error.value = err.message || 'An error occurred';
  } finally {
    loading.value = false;
  }
};

const handleRegistration = async () => {
  currentStep.value = 'registering';
  try {
    // Step 1: Get registration options
    const optionsResponse = await fetch('/api/passkey/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value,
        displayName: userId.value,
        email: null,
        adminSecret: adminSecretRequired.value ? adminSecret.value : undefined
      })
    });

    if (!optionsResponse.ok) {
      const errorData = await optionsResponse.json().catch(() => ({}));
      if (errorData.errorCode === 'ADMIN_SECRET_REQUIRED' || errorData.errorCode === 'ADMIN_SECRET_INVALID') {
        adminSecretRequired.value = true;
        currentStep.value = 'userId';
        throw new Error(errorData.error || 'Admin secret required to continue');
      }
      throw new Error(errorData.error || 'Failed to start registration');
    }

    const options = await optionsResponse.json();

    // Step 2: Create passkey
    // Hint: prefer OS keychain (iCloud Keychain / Windows Hello) over browser password manager
    if (options && typeof options === 'object') {
      options.hints = ['client-device'];
    }
    const credential = await startRegistration({ optionsJSON: options });

    // Step 3: Verify registration
    const verifyResponse = await fetch('/api/passkey/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value,
        response: credential,
        adminSecret: adminSecretRequired.value ? adminSecret.value : undefined
      })
    });

    if (!verifyResponse.ok) {
      const errorData = await verifyResponse.json().catch(() => ({}));
      if (errorData.errorCode === 'ADMIN_SECRET_REQUIRED' || errorData.errorCode === 'ADMIN_SECRET_INVALID') {
        adminSecretRequired.value = true;
        currentStep.value = 'userId';
        throw new Error(errorData.error || 'Admin secret required to continue');
      }
      throw new Error(errorData.error || 'Registration verification failed');
    }

    const result = await verifyResponse.json();

    if (result.success) {
      // If showFileImport flag is set, show file import dialog instead of immediately authenticating
      if (result.showFileImport && result.kbName) {
        kbName.value = result.kbName;
        showFileImportDialog.value = true;
        // Don't emit authenticated yet - wait for file upload or user to proceed
      } else {
        emit('authenticated', result.user);
      }
    } else {
      throw new Error(result.error || 'Registration verification failed');
    }
  } catch (err: any) {
    currentStep.value = 'userId';
    throw err;
  }
};

const triggerFileInput = () => {
  fileInputRef.value?.click();
};

const handleFileSelected = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  uploadingFile.value = true;
  try {
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('subfolder', kbName.value || ''); // Upload to KB subfolder
    formData.append('isInitialImport', 'true'); // Flag for initial import

    const uploadResponse = await fetch('/api/files/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      throw new Error(errorData.error || 'Failed to upload file');
    }

    const uploadResult = await uploadResponse.json();

    // Notify backend that initial file upload is complete
    const completeResponse = await fetch('/api/passkey/registration-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value,
        initialFile: {
          fileName: uploadResult.fileInfo.fileName,
          bucketKey: uploadResult.fileInfo.bucketKey,
          fileSize: uploadResult.fileInfo.size,
          uploadedAt: new Date().toISOString()
        }
      })
    });

    if (!completeResponse.ok) {
      throw new Error('Failed to complete registration');
    }

    const completeResult = await completeResponse.json();

    showFileImportDialog.value = false;
    emit('authenticated', completeResult.user);
  } catch (err: any) {
    error.value = err.message || 'Failed to upload file';
  } finally {
    uploadingFile.value = false;
    // Reset file input
    if (fileInputRef.value) {
      fileInputRef.value.value = '';
    }
  }
};

const handleFileImportCancel = () => {
  showFileImportDialog.value = false;
  showConfirmWithoutFileDialog.value = true;
};

const goBackToFileChooser = () => {
  showConfirmWithoutFileDialog.value = false;
  showFileImportDialog.value = true;
};

const sendRequestWithoutFile = async () => {
  loading.value = true;
  try {
    
    const response = await fetch('/api/passkey/registration-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value,
        initialFile: null // No file uploaded
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to complete registration');
    }

    const result = await response.json();

    showConfirmWithoutFileDialog.value = false;
    emit('authenticated', result.user);
  } catch (err: any) {
    error.value = err.message || 'Failed to complete registration';
  } finally {
    loading.value = false;
  }
};

const handleSignIn = async () => {
  currentStep.value = 'authenticating';
  try {
    // Step 1: Get authentication options
    const optionsResponse = await fetch('/api/passkey/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value
      })
    });

    if (!optionsResponse.ok) {
      const errorData = await optionsResponse.json();
      // If user not found (e.g., CouchDB wiped), switch to registration mode
      if (optionsResponse.status === 404) {
        action.value = 'register';
        currentStep.value = 'userId';
        error.value = 'No passkey found for this user. Please register a new passkey.';
        return;
      }
      throw new Error(errorData.error || 'Failed to start authentication');
    }

    const options = await optionsResponse.json();

    // Step 2: Authenticate with passkey
    const assertion = await startAuthentication({ optionsJSON: options });

    // Step 3: Verify authentication
    const verifyResponse = await fetch('/api/passkey/authenticate-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value,
        response: assertion
      })
    });

    if (!verifyResponse.ok) {
      const errorData = await verifyResponse.json().catch(() => ({}));
      throw new Error(errorData.error || 'Authentication verification failed');
    }

    const result = await verifyResponse.json();

    if (result.success) {
      emit('authenticated', result.user);
    } else {
      throw new Error(result.error || 'Authentication verification failed');
    }
  } catch (err: any) {
    currentStep.value = 'userId';
    throw err;
  }
};
</script>

