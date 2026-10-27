from itertools import product
import json


def eval_cubes(bits, names, cubes):
    out = 0
    for cube in cubes:
        term = 1
        for name, neg in cube:
            i = names.index(name)
            v = bits[i]
            if neg:
                v = 1 - v
            term &= v
        out |= term
    return out


def minterm_set(names, cubes):
    return {
        i
        for i, bits in enumerate(product([0, 1], repeat=len(names)))
        if eval_cubes(bits, names, cubes)
    }


def all_cubes_covering(names, onset):
    n = len(names)
    out = []
    for code in range(3 ** n):
        cube = []
        c = code
        for i in range(n):
            d = c % 3
            c //= 3
            if d == 0:
                cube.append((names[i], True))
            elif d == 1:
                cube.append((names[i], False))
        covered = minterm_set(names, [cube])
        if covered and covered.issubset(onset):
            out.append((frozenset(covered), tuple(cube)))
    maximals = []
    for cov, cube in out:
        if not any(cov != other and cov.issubset(other) for other, _ in out):
            maximals.append((cov, cube))
    return maximals


def min_covers(onset, primes):
    sols = []

    def rec(rem, chosen):
        if not rem:
            sols.append(list(chosen))
            return
        first = min(rem)
        for cube in primes:
            if first in cube:
                rec(rem - cube, chosen + [cube])

    rec(set(onset), [])
    minlen = min(map(len, sols))
    sols = [s for s in sols if len(s) == minlen]
    minlit = sum(len(c) for c in sols[0])
    sols = [s for s in sols if sum(len(c) for c in s) == minlit]
    return sols, minlit


def check():
    names = ["A", "B", "C", "D"]
    onset = {0, 2, 5, 7, 8, 10, 13, 15}
    primes = all_cubes_covering(names, onset)
    sols, minlit = min_covers(onset, [c for c, _ in primes])
    bd = frozenset({5, 7, 13, 15})
    bndn = frozenset({0, 2, 8, 10})
    primes_sets = [c for c, _ in primes]
    result = {
        "unit": "KU-032",
        "example": "F=BD+B̄D̄ for Σm(0,2,5,7,8,10,13,15)",
        "onset": sorted(onset),
        "primes": [
            {
                "covers": sorted(cov),
                "literal_count": len(cube),
                "is_necessary": any(cov == target for target in [bd, bndn]),
            }
            for cov, cube in primes
        ],
        "prime_count": len(primes),
        "min_term_count": min(map(len, sols)),
        "min_literal_count": minlit,
        "example_cover": {
            "BD": sorted(bd),
            "BnotDnot": sorted(bndn),
            "union": sorted(bd | bndn),
            "covers_all": (bd | bndn) == onset,
            "necessary_unique": bd in primes_sets and bndn in primes_sets,
        },
        "passed": (
            bd | bndn == onset
            and len(primes) == 2
            and min(map(len, sols)) == 2
            and minlit == 2 * 4
            and bd in primes_sets
            and bndn in primes_sets
        ),
    }
    return result


if __name__ == "__main__":
    print(json.dumps(check(), ensure_ascii=False, indent=2))
