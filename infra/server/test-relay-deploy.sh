#!/usr/bin/env bash
# Tests relay-deploy's decisions with fake git, kubectl and flock: no server, no cluster.
# The script calls git and kubectl by name, so fakes placed first in PATH replace them.
# Usage (from the repo root): bash infra/server/test-relay-deploy.sh infra/server/relay-deploy.sh
set -uo pipefail
SCRIPT="${1:?usage: test-relay-deploy.sh path/to/relay-deploy.sh}"
GOOD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
BAD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
passed=0; failed=0

# A fresh fake world: the script with /home/deploy pointed at a temp folder, and fakes in PATH.
setup() {
  T=$(mktemp -d)
  mkdir -p "$T/bin" "$T/home/relay/k8s/app"
  echo "kind: Deployment" > "$T/home/relay/k8s/app/api.yaml"
  sed "s#/home/deploy#$T/home#g" "$SCRIPT" > "$T/relay-deploy"
  # git: "checkout" notes which commit is checked out. The main check (merge-base) says
  # "not on main" when not-on-main exists. Everything else (fetch) passes.
  cat > "$T/bin/git" <<EOF
#!/usr/bin/env bash
case "\$*" in
  *checkout*) echo "\${@: -1}" > "$T/checked-out" ;;
  *merge-base*) [ -e "$T/not-on-main" ] && exit 1 ;;
esac
exit 0
EOF
  # kubectl: every call's first word goes to "calls", so tests can check the order.
  # apply notes that it ran, and for which commit (applied-commits), and prints the API's
  # Deployment, plus dashboard, worker and demo receiver when their manifest files exist (or fails if
  # apply-fails exists). rollout status notes which Deployment it waited for (rollouts) and
  # fails when the checked-out commit is listed in "broken" (every Deployment of that commit)
  # or, for a single Deployment, in "broken-dashboard" or "broken-worker".
  # create (the migrate Job) reads the commit from the Job's label and answers
  # job.batch/migrate-<first 5 characters>, or is refused when create-fails exists.
  # get <that job> answers the Job's true conditions: "SuccessCriteriaMet Complete" unless
  # job-state-<5 characters> says otherwise (an empty file = no verdict yet), or fails when
  # get-job-fails exists. logs prints a line. get (pods, events) prints a line, as the real one.
  cat > "$T/bin/kubectl" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$T/calls"
job=""; for a in "\$@"; do case "\$a" in *migrate-*) job="\${a##*/}" ;; esac; done
case "\$*" in
  apply*) cat > /dev/null; touch "$T/applied"; cat "$T/checked-out" >> "$T/applied-commits"
          [ -e "$T/apply-fails" ] && exit 1; echo deployment.apps/relay-api
          [ -e "$T/home/relay/k8s/app/dashboard.yaml" ] && echo deployment.apps/relay-dashboard
          [ -e "$T/home/relay/k8s/app/worker.yaml" ] && echo deployment.apps/relay-worker
          [ -e "$T/home/relay/k8s/app/demo-receiver.yaml" ] && echo deployment.apps/relay-demo-receiver
          exit 0 ;;
  "rollout status"*) echo "\$3" >> "$T/rollouts"
          grep -qx "\$(cat "$T/checked-out")" "$T/broken" && exit 1
          [ "\${3##*/}" = relay-dashboard ] && grep -qx "\$(cat "$T/checked-out")" "$T/broken-dashboard" 2>/dev/null && exit 1
          [ "\${3##*/}" = relay-worker ] && grep -qx "\$(cat "$T/checked-out")" "$T/broken-worker" 2>/dev/null && exit 1
          exit 0 ;;
  create*) commit=\$(sed -n 's/.*relay.myrelay.tech\/commit: "\([0-9a-f]*\)".*/\1/p')
           [ -e "$T/create-fails" ] && { echo 'Error from server (Forbidden): jobs.batch is forbidden' >&2; exit 1; }
           echo "job.batch/migrate-\${commit:0:5}" ;;
  get*) if [ -n "\$job" ]; then
          [ -e "$T/get-job-fails" ] && { echo "Unable to connect to the server: i/o timeout" >&2; exit 1; }
          if [ -e "$T/job-state-\${job#migrate-}" ]; then cat "$T/job-state-\${job#migrate-}"
          else echo "SuccessCriteriaMet Complete"; fi
        else echo "fake kubectl \$*"; fi ;;
  logs*) echo "fake migrate log of \$job" ;;
esac
EOF
  # flock: gets the lock, unless lock-busy exists (another deploy holds it the whole time).
  printf '#!/usr/bin/env bash\n[ -e "%s/lock-busy" ] && exit 1\nexit 0\n' "$T" > "$T/bin/flock"
  # sleep: returns at once, so a "wait for the Job" loop runs its tries in milliseconds.
  printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/sleep"
  chmod +x "$T/bin/"*
  : > "$T/broken"
}

# The same fake world, plus a migrate Job in the commit (k8s/migrate/job.yaml, from Phase 2).
setup_migrate() {
  setup
  mkdir -p "$T/home/relay/k8s/migrate"
  printf 'kind: Job\nmetadata:\n  labels:\n    relay.myrelay.tech/commit: "__GIT_SHA__"\n' \
    > "$T/home/relay/k8s/migrate/job.yaml"
}

# Runs the script with the fakes first in PATH, and prints its exit code. A watchdog stops it
# after 30 s, so a script that hangs (for example a wait loop that never ends) fails the test
# instead of hanging CI. The watchdog uses the real sleep: only the script's PATH has the fake.
run() {
  SSH_ORIGINAL_COMMAND="$1" PATH="$T/bin:$PATH" bash "$T/relay-deploy" > "$T/out" 2>&1 &
  local pid=$! tenths=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$tenths" -ge 300 ]; then
      kill "$pid"; echo "(the watchdog stopped the script after 30 s: it hung)" >> "$T/out"; break
    fi
    sleep 0.1; tenths=$((tenths + 1))
  done
  wait "$pid"; echo $?
}

check() { # check "<name>" "<actual>" "<expected>"
  if [ "$2" = "$3" ]; then passed=$((passed + 1)); echo "  ok    $1"
  else failed=$((failed + 1)); echo "  FAIL  $1: got '$2', expected '$3'"; sed 's/^/        | /' "$T/out"; fi
}

echo "1. A good deploy"
setup; code=$(run $GOOD)
check "exits 0" "$code" 0
check "remembers it as last good" "$(cat "$T/home/.relay-last-good" 2>/dev/null)" $GOOD

echo "2. A broken deploy, with a last good commit"
setup; echo $GOOD > "$T/home/.relay-last-good"; echo $BAD > "$T/broken"; code=$(run $BAD)
check "exits 1 (CI turns red)" "$code" 1
check "puts the last good commit back" "$(cat "$T/checked-out")" $GOOD
check "last good stays the same" "$(cat "$T/home/.relay-last-good")" $GOOD

echo "3. A broken first deploy (nothing to go back to)"
setup; echo $BAD > "$T/broken"; code=$(run $BAD)
check "exits 1" "$code" 1
check "doesn't invent a last good" "$(cat "$T/home/.relay-last-good" 2>/dev/null || echo none)" none

echo "4. The rollback fails too"
setup; echo $GOOD > "$T/home/.relay-last-good"; printf '%s\n%s\n' $BAD $GOOD > "$T/broken"; code=$(run $BAD)
check "exits 1" "$code" 1
check "did try the last good commit" "$(cat "$T/checked-out")" $GOOD

echo "5. kubectl apply fails (the set -e trap inside a function)"
setup; touch "$T/apply-fails"; code=$(run $GOOD)
check "exits 1" "$code" 1
check "doesn't record it as last good" "$(cat "$T/home/.relay-last-good" 2>/dev/null || echo none)" none

exists() { [ -e "$1" ] && echo yes || echo no; }

echo "6. Gate 1 refuses anything that isn't a full commit SHA"
for input in "whoami" "$GOOD; touch /tmp/pwned" "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" "$GOOD "; do
  setup; code=$(run "$input")
  check "refuses '$input'" "$code" 1
  check "checks nothing out for '$input'" "$(exists "$T/checked-out")" no
done

echo "7. Gate 2 refuses a commit that isn't on main"
setup; touch "$T/not-on-main"; code=$(run $GOOD)
check "exits 1" "$code" 1
check "checks nothing out" "$(exists "$T/checked-out")" no
check "applies nothing" "$(exists "$T/applied")" no

echo "8. A failed rollout shows why in the log"
setup; echo $BAD > "$T/broken"; code=$(run $BAD)
check "prints the pods" "$(grep -q -- '--- pods' "$T/out" && echo yes || echo no)" yes
check "prints the latest events" "$(grep -q -- '--- latest events' "$T/out" && echo yes || echo no)" yes

echo "9. A damaged last-good note is never used"
setup; echo "not a commit; touch /tmp/pwned" > "$T/home/.relay-last-good"; echo $BAD > "$T/broken"; code=$(run $BAD)
check "exits 1" "$code" 1
check "never checks out what's in the note" "$(cat "$T/checked-out")" $BAD

echo "10. Another deploy still holds the lock"
setup; touch "$T/lock-busy"; code=$(run $GOOD)
check "exits 1" "$code" 1
check "says to re-run" "$(grep -q 're-run this job' "$T/out" && echo yes || echo no)" yes
check "changes nothing" "$(exists "$T/checked-out")" no

# From Phase 2 a commit can carry a migrate Job, which must finish before anything is applied.
order() { grep -xE 'create|apply' "$T/calls" 2>/dev/null | tr '\n' ' '; }
applied_bad() { grep -qx $BAD "$T/applied-commits" 2>/dev/null && echo yes || echo no; }

echo "11. The migrate Job completes"
setup_migrate; code=$(run $GOOD)
check "exits 0" "$code" 0
check "migrates before it applies" "$(order)" "create apply "
check "says which Job" "$(grep -q 'migrating with job.batch/migrate-aaaaa' "$T/out" && echo yes || echo no)" yes

echo "12. The migrate Job fails"
setup_migrate; echo $GOOD > "$T/home/.relay-last-good"; printf 'FailureTarget Failed' > "$T/job-state-bbbbb"
code=$(run $BAD)
check "exits 1" "$code" 1
check "never applies the failing commit" "$(applied_bad)" no
check "deploys the last good commit again" "$(cat "$T/applied-commits" 2>/dev/null)" $GOOD
check "last good stays the same" "$(cat "$T/home/.relay-last-good")" $GOOD

echo "13. A commit without k8s/migrate/ (from before Phase 2)"
setup; code=$(run $GOOD)
check "exits 0" "$code" 0
check "creates no Job" "$(grep -cx create "$T/calls")" 0
check "still applies" "$(exists "$T/applied")" yes

echo "14. Creating the Job is refused (for example the Role lacks jobs)"
setup_migrate; echo $GOOD > "$T/home/.relay-last-good"; touch "$T/create-fails"; code=$(run $BAD)
check "exits 1" "$code" 1
check "never applies the failing commit" "$(applied_bad)" no

echo "15. The Job never reaches a verdict (it stays Pending)"
setup_migrate; : > "$T/job-state-bbbbb"; code=$(run $BAD)
check "exits 1" "$code" 1
check "never applies the failing commit" "$(applied_bad)" no
check "says the Job may still be running" "$(grep -q 'may still be running' "$T/out" && echo yes || echo no)" yes

echo "16. A failed Job shows why in the log"
setup_migrate; printf 'FailureTarget Failed' > "$T/job-state-bbbbb"; code=$(run $BAD)
check "prints the Job's log" "$(grep -q 'fake migrate log of migrate-bbbbb' "$T/out" && echo yes || echo no)" yes
check "prints the pods" "$(grep -q -- '--- pods' "$T/out" && echo yes || echo no)" yes
check "prints the latest events" "$(grep -q -- '--- latest events' "$T/out" && echo yes || echo no)" yes

echo "17. Reading the Job's state fails (no connection)"
setup_migrate; echo $GOOD > "$T/home/.relay-last-good"; touch "$T/get-job-fails"; code=$(run $BAD)
check "exits 1, never success" "$code" 1
check "never applies the failing commit" "$(applied_bad)" no

# From Phase 5 the dashboard is a second Deployment in k8s/app/: the script must wait for each,
# and a dashboard that never gets ready must roll the whole commit back, the API included.
with_dashboard() { echo "kind: Deployment" > "$T/home/relay/k8s/app/dashboard.yaml"; }
rollouts() { tr '\n' ' ' < "$T/rollouts" 2>/dev/null; }

echo "18. Two Deployments, both fine"
setup; with_dashboard; code=$(run $GOOD)
check "exits 0" "$code" 0
check "waits for each one" "$(rollouts)" "deployment.apps/relay-api deployment.apps/relay-dashboard "

echo "19. The API is fine, the dashboard never gets ready"
setup; with_dashboard; echo $GOOD > "$T/home/.relay-last-good"; echo $BAD > "$T/broken-dashboard"
code=$(run $BAD)
check "exits 1 (CI turns red)" "$code" 1
check "puts the last good commit back" "$(cat "$T/checked-out")" $GOOD
check "last good stays the same" "$(cat "$T/home/.relay-last-good")" $GOOD
check "waits for both, then both again for the rollback" "$(rollouts)" \
  "deployment.apps/relay-api deployment.apps/relay-dashboard deployment.apps/relay-api deployment.apps/relay-dashboard "
check "prints the pods" "$(grep -q -- '--- pods' "$T/out" && echo yes || echo no)" yes

# The worker is staged at zero before activation. The receiver adds a fourth Deployment.
with_worker_and_receiver() {
  echo "kind: Deployment" > "$T/home/relay/k8s/app/worker.yaml"
  echo "kind: Deployment" > "$T/home/relay/k8s/app/demo-receiver.yaml"
}

echo "20. Four Deployments, all fine"
setup; with_dashboard; with_worker_and_receiver; code=$(run $GOOD)
check "exits 0" "$code" 0
check "waits for all four in apply order" "$(rollouts)" \
  "deployment.apps/relay-api deployment.apps/relay-dashboard deployment.apps/relay-worker deployment.apps/relay-demo-receiver "

echo "21. A rollback never deletes anything"
# The script can't delete, so a Deployment added only by the failed commit stays; that's why
# the worker is added at 0 replicas first (k8s/README.md).
setup; with_dashboard; with_worker_and_receiver
echo $GOOD > "$T/home/.relay-last-good"; echo $BAD > "$T/broken-worker"
code=$(run $BAD)
check "exits 1 (CI turns red)" "$code" 1
check "puts the last good commit back" "$(cat "$T/checked-out")" $GOOD
check "applies the failed commit, then the last good commit" "$(cat "$T/applied-commits")" "$(printf '%s\n%s' $BAD $GOOD)"
check "last good stays the same" "$(cat "$T/home/.relay-last-good")" $GOOD
check "waits through the broken worker, then all four on rollback" "$(rollouts)" \
  "deployment.apps/relay-api deployment.apps/relay-dashboard deployment.apps/relay-worker deployment.apps/relay-api deployment.apps/relay-dashboard deployment.apps/relay-worker deployment.apps/relay-demo-receiver "
check "never calls kubectl delete" "$(grep -cx delete "$T/calls")" 0

echo; echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
