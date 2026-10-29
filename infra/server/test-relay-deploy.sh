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
  # kubectl: apply notes that it ran and prints one Deployment (or fails if apply-fails exists);
  # rollout status fails when the checked-out commit is listed in "broken";
  # get (pods, events) prints a line, as the real one would.
  cat > "$T/bin/kubectl" <<EOF
#!/usr/bin/env bash
case "\$*" in
  apply*) cat > /dev/null; touch "$T/applied"; [ -e "$T/apply-fails" ] && exit 1; echo deployment.apps/relay-api ;;
  "rollout status"*) grep -qx "\$(cat "$T/checked-out")" "$T/broken" && exit 1; exit 0 ;;
  get*) echo "fake kubectl \$*" ;;
esac
EOF
  # flock: gets the lock, unless lock-busy exists (another deploy holds it the whole time).
  printf '#!/usr/bin/env bash\n[ -e "%s/lock-busy" ] && exit 1\nexit 0\n' "$T" > "$T/bin/flock"
  chmod +x "$T/bin/"*
  : > "$T/broken"
}

run() { SSH_ORIGINAL_COMMAND="$1" PATH="$T/bin:$PATH" bash "$T/relay-deploy" > "$T/out" 2>&1; echo $?; }

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

echo; echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
