const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const makeWASocket = baileys.default?.default || baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers, delay } = baileys;

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';
const OWNER_ID = 5846687574;
const SUB_ADMINS = new Set([8264531154]);
const MAX_USERS = 25;
const PAGE_SIZE = 11;
const BROADCAST_DELAY_MS = 15000;
const SCAN_DELAY_MS = 200;

const logger = pino({ level: 'silent' });
const isOwner = (id) => Number(id) === OWNER_ID;
const isSubAdmin = (id) => SUB_ADMINS.has(Number(id));
const isAdmin = (id) => isOwner(id) || (isSubAdmin(id) && !bannedUsers.has(Number(id)));

const RAW_INVITE_CODES = `
B6kliMPOycnKSanjaztmJM B7ryAy4mCUuCuVlqBA6bNp B7tvHQ5BdrKDMAASoZxETp B7W5gpUVLxqFwZYuMlAiAA B8gvhQGOP19GygmaTEHPf3 B9hZvdsOI30KOhpGE8RSdz B9TTnIDTM1d4o9yE9zx40z B9zqDXlxQBaBIfKPZT8AH4 BaBdMx1PTfTF9gKAKnVlRF Bb6Cp3Hdkhv864U30Q63jp
BBKGY5iAnj6DTOiGrkEgL2 BbxUXeuHdzPASPqRBrXKk2 BC4DGnJhmza3kO7zopw4sV BCeZH4wAHQ8JvR6dh9kUZC Bcm23XDWyCf978GZvIiZhk BcMiFwgzGaa0rRl5jczmrb Bcn4KgTn0szIt5L11isnv1 BCWd3In9Kta2iZ2SUXE0NY BDlAXZ91VoI7rfLGZwHlAh Bdo6i0NOIeWJTiJNGDIK2w
BdT1S0yjSNy0lLzVUL1qc7 BDWvpnF092t3EYEEb4UsAY BdZRvlaNw5k0zpx8LVDxYw Be2117VrI30EKV8WyJmZm4 BegysqnDLnh8uzW7u538R3 BeluxvZBml2HC31MaMPVdr BEpsqEzuAScIqRgrNbKiEo Bf1ucqUAqxzHAv28J498ck BFiY7OYeiAsIsYFQIeCxUh BgAAdRzZZIv0KaGb0NRMBW
BgabBMBi2LL8H6Q95BMzMG BGd4p57UP3x1kIm614qamd BGjB4NswiIs6Egd6ULwZnm Bh9xCccHXSh5oCSc90oaTt BhrCdpQmKcf5jEst7qJzLO BHVv94eha687QNXfOXPYM7 BIh0H8NNYm0549Zpnzu2iq BiH99IhbNYKKizyvnGCmyp BIP1IMlaKNv2xMV7K2k6GW BJ5vmyeGc47A6Pz32qrd7y
BKIOHHqYbYR3ji7VLvKoVJ Bl7IpcWAc9r0qtJgcLXXbk BLBbBouOviT5TV22HX6VNR Bm5Vw0bS0yG47iRLzXNipl BmliqObFpEy0eG8IunQsv6 BMxUvIc9pnx90ZXUis0s5v BNu4SS1Uor7DhFcTcoFESU Bo0uO5pUpzdA8aIOZ23TTi BoMLm7gY9m3AUp0Xc4mRcF BoqYagxgjnP0ETclMQu0Pp
BOrmWMwKjDOIj18am8KB5A BovzF3QWrmV67sHueWqCMO BP3FzOA1DbFEnDgIVRRMzI Bp5h6yYzypnKOYjyJxpcxh BpaXTRs7k2t36ZRAmlxlLy BPiQNSBNvIQ2rTQY1qq5oi BpVvSG9IYr3DWQz72LUXc8 Bq7irXgEADcDQTrO6YkGIT BqERqZRmPcXJnUn8JhaA9L BQJfeyHUWgD1Vk667I7WZd
BRarXr2C6mHKmgpIJ3f9jV BRCmBUeiJ9mF6aUvxpiq7A BRCyEDyAgjIE7wSWlAt3Xs BrPiGsQZZQdIScJMEjlHIu BRPNh8FT7RXLjCIYFviKC0 BrQZ2Roz9CR7G50OqdcY0c BRSsInefAMa058HRgZ2DqH BSiEXa1S6r9Ayd5Q2amzeB BTAUaApdPXnIwJ9xd4XfCm BTDryxdiqcE1qgu3FlsW08
BtOCvkezuLqFppXJDv2XW0 BTxBvk2kU777XU2DzOXGt8 BTyL11FIvOGFmDj78F4wI9 BUDOuQm4YMMHfexkTYqhzV BuFOkd2Diuu9vUAilaPPBz BUvOJMau6UUBW4eAuYDQqw BuWwj71dmv22QmGqUdZOcM BViXgcOVNZNEYBkMPBEuqo Bvv0S8TlrzvAMt5OEBNf83 BvXrspWfRMjLaIlXFh5ie2
BvzfzIehtlk1YDfTBlTdAh Bw5duhUQKd4Hx9m1MaFsWU BwbGcNfbcNR52l6VdCAoIB BWBZsU71QMjC6liLp3e6N4 BWDHRA4E2dGBSR8UBood0l BwdjCvSbBnJGH8axLfDbFD BWJPCB0aiXrLVp411dSc0I BWZCOXyHvVZ6ySLBmXSodB Bx2A6122MhXFxFglIYHdqU Bx4yOzYjqPAF9mQWX6enGw
BXIolbUhrrhF5gycpZbqMu BxjL8kwxkYTEbTHwaHw2ab BXKXNNwWvL7J3uFBM3NX9e BXLnQRk7Tdq2eOTI2bZSfq BXwZgaqhx2z3h7qUSXkKya ByNwcjnut4OER502fdLY5Z BYRQJRjj0YQ8oziVAFFFhd ByS7017vzS2FggUIiXfXIQ BYx9UTwrO8G7GZ8BRD33hr BZ2vVRBLb0x3qlISXRgIPo
BZ46TLv4UJk0NJbXUXqfFt Bz7DLe00cHB482OxUF15K8 BZAfJcxIEjzLxAPXDXr4VM BZcgrAfIePpHSx58CkthuJ Bzej0pordym5QpamS0rHuP BZOpJsJJETSIO6WUB4o71B BZVE2Hcf44x9LXfKC9wrYp BzxPiryCtox1HMhnTUYr6w C0Fp8lOZjvOFSeNx3MnTL0 C0pD9Qxfnty5VX4oBJ8r9P
C1fik2TY6qbBiVEDE1aP2E C1r8hAtAZOe244mdEqHag3 C24iLTKs3s7B60CGr1CAbQ C2LxSvCjOulI4Ov6GtwexS C2wM5G4XQmpFKkJKyok7dm C3qixPXgdLOFc14el8B0IE C47ly9VUS6XLkb5ACw66oU C4CUxd1I5tH7Kt5fO5sHiv C5Ghjx4Jps7COSrQuKvMqU C77eiCcJSncFZRfJLzPnLf
C8I30coTeWZ6hyLlaQhSp5 C8Iw26N5ZUz4gGM1FsAnwA C8j4MxjQEEr37QaMzL2K5H C9R9b12Nzck4taRzr2pJPT CAF2uFNTLlo588zg74iC27 CaH0E8ZtC2o11kyoi1YnoV CahtcDxaVm4E65haMeZuGS Camtku2XCVwJlCMIlGzlgd CbfHJvQf0hu41dWJn43KKo CBn7SvTIfEk4aDlPHQl5vZ
Cbvfj7AovyxE0LfKZvRuWC CCagFtvyyKuLjjYz1tJkPp CCm6KyQvPbc9P8tUxjB1Z9 CCstROw20TX8haC6LQpQbd Ccz9XunVqvNE7ZiozHUQcu CD5toJyMtyODXZGNLuXPgj CDTsPt925XdBpO5Dk5B1Wq CdZWhKWFyoIHrRG4Dewuc9 CEJQe7ivr025HcQCQwu1V1 CEOpiSUmhSlFBQuCkyMDgL
CFCgheB0B91HhwaCOPBLwB CFMdJLPrZSYJOaIzE1LzB1 CFoQwA9JfN1Ax9TEmJwYWs CFtcyDA0cgfAfFORY0OGym Cg6ElsEoaGG2RYXixgXYyp CgaGxrLvKnfFVIn5apA1ak CgECE2peKPZEGj0I6LIfQT CHjqsFMO9nY4UP37od2CZ5 ChtKIw0sfLfAQjquVI6sHH CI0EG8loojyESAYlG9ZqME
CI30Ai6a7HTLY07Zoy6kIV CId1D88XbIL2nnx1L06QWR Cid2OowGfPHDSBdQP3JLSj CIhJSo9DxS6DLGgyjE4Avy CiZAq7CKWqrIl9ikUN8Llk Cj1mzvU2BTMH8WkpslIPQv CJFY9y7LhJV8i07VTvJ3Aj CJhNwFL8LRS50ZnltWH6Qb CjUCe3LbOsDBnrJHWVVW8Q CjWdOFL6akhJuAcNdHeubn
Ck4hBYOAnuJGl1Gl9G6EZD CK58rXzFxbU6aCi130wSEB ClaIWBim50pBQF11L6VpRm CMGRTsHrYRZ7hFeaRz2QDp CmLCVUQCnOpEHDDCEUSVjj CmoF42i3gPvBlaI5xq9y9M Cn0OBSin6dyIWaT71zfxaY CN1OwO8xFBQ6kWWigwuYjv CnJB75BeNbVHH94kD4UgIj CO2fLf36RndKpAtLJHpROf
Co8YrGEUq69F0bn7bR41hu CORrUZtRJJTGMPKiy1TXyY CoxQKvHA8lJ4Raaw7XCWmg CoyPIRSHPghESBcg6ZYIg5 CPA0BX9Jlr7FJrHttJCfb2 CQbXEbvVJ8N7CXOHiglSTx CqJCfI5QheM5QaIof7cIZb CQLFbX0Af0w87jwA1Cp3Gn CQvNFpKb4KL7UB6dfaNyIG CqXCZUXlHjp4K136MxsWAD
CqyxDSHk5xX3xqrOEH85iP Cr0hvLC3x3LEkhCUOroeuk CRfVAflwDu6BwiegnIcx3K CRTWDe3ygmCDt2gDjfEwOk CRYAv8XAd9d3aGmtSbcEbD Cs12ChIaEHWFDNO7g5kIfQ Cs6HXu2HbUxKWkaROk4F2L CSIbfZLBOT14J4VljOw0u7 CSQwOuUuZ4WGRDJaInEKk5 CSzPSu2oOGTLR8303kPPdN
CT21MwLRIJu4PCc7qwXZoJ CtVvjbocjid1qbV90y82CM CtzFVuj62JCJP3Mr67xRaH Cu0k7LcvLlJ3kp7ALtsF0N Cu9Kv8KWEYHH19bmvRONiL CufLkm2x3WtBnx7vrBJDVD CuS5IIRShMf0cDpZApNwqi CV8m3zRvO3n2kMJu0wu5yj CVEn7jNGOT236SSoikVic6 CVpJdPkPnqHB5KIOc0O6k8
CvyE83EZazKAtrPwGFzJJN CwxqdqMCKEiAp2Fh5KZwFx CxaQDCMrSgy01Uu7zLXkkh CxmpR28ZfqwC5GbknVzvIS CXtOI2KYw16KbWwAIdijgZ CxWdD34Q1ML1PbtuTZbuox Cy7qCiBQva049QWY2NggAY CzLt1lCGpkW9zGr9JD77Xk CZQEWU7UVan36cPcc4yU0n CZuUhBzpdfaD1Ona4mTVIe
CzYGMbqbV9lI6cNsCEfNXC D077oIb0Sd3CLwZnebzuL4 D0h3fdLJwqT1MRFcchkJon D1pQPGSUT0VDV9AJy9H9ZX D1wj6soPWDfDM8eBsc8e8q D2MYnCqSLGc2y0NdP5dwaT D3E2Y47dfoMIuG7CpY2SPA D3QlpEcnoL9Jf5SnduWncT D4Ap8vcGkv63I6hjW6ru1g D5RwEgVd595Db2RPmmICps
D5ZkRQgr5snCKC3ACUmH4V D7HnOoDfj8y0cu9pRKtjfP D8b2OyuAyKBBNa9UhNiYfg D8o3CvzQzBD39ZJiopP3V8 D9OjjHnWKby29eSGV5bBhI D9YnI3oXF7j40M1vlcWqHD DAeldwzk1DtDNqRrC7hYwV DaPV2l3gXhnBd1ORp8R3eV DArkBVAoztFHaRHGfYcjSL DAztKOXuRSu5ONUWoNjPfN
DbCzFz3av30AwGgIZ9Bnyw DBFjoxmXzPm3pghf3SpEHt DbTODkZzPaw5VgPyHbzsAD DC4tAHyYyngKjngod6bSAS DC5ieGAoqJoLG8aLFb4Gi1 DC9L10QDKJP5sCNXoMHyst DcLi6hjONcKKSQodfekgM1 DcU5WMmBlhi0phcx7Mqwc4 DcXM56zRZ1o1d3E5n80N52 DD0h1YYVLZqFlz4RCnWObo
DDdsjyN3Qrw1VzHnLIbH3R DdqBY4A8Yb15A9YYqY7Mfu DDTDTQhlyOV54qsQm97BNU DDyqdAGFTl9Gbw0Y6N45Kd DeR3SyWA4jO2AK3BBRSepI DEZlpx66Og1FE32x8MMimG Df3AysqfJC12gjsHuXQtrW DF5bznkjQv3JUZK9Iq9X5E DfIRgvFJ0IiKXRuHZGPvAi DfwRZ2CY61J35R4dJexqTC
DG2yM9an5g228lWGm9doB1 DG4SIDahW5pAm2cUwQyOF5 DGbifGjvEUmEUbLTvjocws Dge3EByIAQSC3rRaeR0XKH DGJnYoqySHPLuRkZA48V15 Dh5eUeC5JSBGiFLR7CogBn DHbEaaDwYz138nxdrHtRiC DHBucbjpIviJpFVXf9Pk73 DhtmC41M8ySJymmgpEQr70 DHy64QroTSR3yDV1V36r3F
Di7L3owCdc9JPqpERxqrFD DIctlIXyz2t8f12zCM1Dti DiPHhoyHg8aC04RiuLCKr2 Divq72XNL8t5iZpHfgE9cN DIxAiDd1O6f2M08TOpoG5W DjCPOnoSkvg70tSgNwjpkp DJCvAEx2W21E9DXykQwu8B DjUxWym06hXJTffAB8e8V1 DK7TZSfJ2bG9iqr0a45f5y DKBtxNReuEd0a7hgJr2bAK
DkC9buuYezLLS25qhjYOEL DKJGVj3pUsyJu0suh9UmwN Dknm6BK7d3BDZyd31yVW6n DKwLmwtdUoC2OI8wPz2h0W DM077wQ1LX4Gz5SwvaVjuz DM6IvXL1bygCZ8nLlwIWVD Dn9Js8F0g91Empqhxt0OYV DnNgymm8ca83XGf3ScGsUJ DnwUmSPKBTR6HOvMawLaIW DnzHWGGU19v1yeJ7vTCbXh
DOOImlQEWR9Iqsxq0JXnsg DoTaAKTguw41KtnBby3SSJ DoxYhPINTg6AzPwcrAouiP DpeCHf096ezLXtza8h3FQZ DPWksVTZ42NJZl6wQhWrfV DqHa9kdxvcE2xb53J311Cu Dqj8fFaSHbrIZcRORPZJ3y DqMpTw472tlAjD4sXkumbi DRaZznyQ7QwIt6OhfHNQN2 DrJ2Ec3PITs6iNiObxYzJ1
DRKmyLQHMK4KZ3GOFOVpT4 DSGhOXRyYf8AthpkJSnx5s DTGGU8w5rIlLgG6HPdgp0t DtJ6LAv3CsKIqHicJnxM2v DtJm3zibmCi1E5bbXMknF7 DTKOiGiJVHHAjZZltjHOkM DTNcGTLAJG4FUgKJo3RDQC DTYoFzXcDbe0URko33UoS7 DU0I0QQB72fHySz1oi2iin DUB3KmCRdNVGruxpaKi8Wy
DUKwMUcSw2AEBlb0Ejc9DN Dwb124qqI0tJZ7lvQ95xWJ DWc4h5B9TP3ICIWHXqwEue DxFMqxrTOtOAS8Xlws519G DxOAF9mt0onDgkDqHiQZKe Dxt4f7Q1rZn14CFuQTt2Zs DxW0ilO3FMkAw83iyIzMRZ DyAKV6m809m4tm3zAuqFJF Dz10giyfb0Y8fP4sGefamR Dz9CePagAO6G5ouPEJRAxr
DZuk9XIvyUA7o2Dyjhdz1W Dzx9yIBY4ziDpqNvjY1wA1 E0cS0HvQQVsKVMRdRKXEUO E16iyzGcY8p0iq7YBuOCBE E2cOzsqgU2aHxzbd6U9Tgr E4aTOTyQDCoBT4MKV9n96l E4Kqk57BcIHH4n3dbhaQuG E4YU5SReoDrA7RbWzyN8Rf E6EOHsOlA6F28RsM1tiTta E6l1a0jkboxGaAdTAVjitF
E6QMf8Cf1AVDrwBuJs0Lp2 E7eFjYB3OaIEVruskAPFgZ E7TbwwPpvTb8yqfZFmdp5V E8ey3ZqUPm6BuT1JZCBvon E8lgFlz09ue4MJPjeBP3wV E8RQMM2Xk5b4yHJHmkPVZn EaekKKKTRdmKwEV1IRTB3c EAvJsSOpdowCzFBXgjF2VY EAVnO2pksB1L5aTXUWooFi EB7jsL7pRI6JKoteuEM2k2
EbcUrMqOqW72yNBFJj2wBj EBIxiWmOeVj0xmalryFF2Q EBnqMceyj44LF3ze1OLuvF EBXUmqOZkbA90tp4as0bak EBybDZw5tUREfBPitGLGDD ECCotMgHiFVHbUf0YRIQG9 ECZQ0TbZci7Ftc2ovDtMrv EDeJ9tP9vjpDDfDVGndg07 EDGu04pUSTEGaH9WSB8CGt EDMwOp2dv69Hvd8tuPNUzS
EDPw4UbzA6eAivNqx8H5KZ EE53gSk9SYD5LkO6GtoBnv EeEOsJldFqoJ75ew7zQy2j EEOq5lTKtUtEvCRybS4Vsu EETkUau4PGD8H1BEyeOT1P Ef3qhWooAJkDzO5OP5dZx3 EgJY2Mc3xGWFqqh9LUPIk5 EGuGBMzynk5Ij0bHzqjIGC EhFQXTEsTYM8FNtbGdWegY EHL0m5DLlXpIkksc4lA2Kb
EHl3P7yZtdiICjwqaL9Apb EHyjNHp2XlMH4GmTznrzNE EiDgoIS31jrKJaxpdoouWw EiDZJ8ryhbZEMYA4LqggyA EIsaVj891QS7skcDphq9uZ EJ5flywtFze9vHjnctYzDH EJWaZnAyZkP7d1F078p3ai Ek2yIASbrQdCJ7y9Akf26n EK4bdn2tLTqGTDAXHDmHEQ Ek7FKfGutrq9FCfeb7wtVl
EK8kRs6RoMWDI85uh4Rd9X ELaqKHCAVe20U7Bsu1mauc ELsl0gizLFsDRkpPdwbwwI Em0KLq9OLJY1QYTPFUUoiO EM560Umvco03RlvLlWuQZo EM8as0hkzTmJzWz0Hlrz3d EmAfYHe9WAF7ebvo6ufDYO EmaM6janvTvEQHfcbGdfYX EMCs9oiUmEBA113GM9m9VR EmfgJAwHEu5EpW1v9ZwQcp
EmOpF07WkbJHHtjRePUL75 EmyauNW6fFnK0i2gGvlCSo EN4al6Kp56NAvDIzCPhyUO EO102i6y5AYFm6qMASlu2Z EoH8qjTqbHi0bdoBcEgfZX EOns30KEOk56lH9DgZ7J8I EotbDVEPkz9A1C0QMvKumr EOw3VJDhVzcAf51qSD17Ql EPu8GdU16pO2jEwJY7Eu1q EPVbjMQDfvD0LjaQXhNHQO
EpzuGyRBSZL7aouFAlaNg0 EqdL5U6XEOHHIS9NVqob9U EQNpEiKqLjn391jzwQZSYn ERAmBvVwcZ5161HchmsCWS ERaZi8kkdrV7C4xM5NejcI ErBKAdl3NSULRrC6QIwNFm ErHt6Z2cVvfGVwPkbC0mct ERSFLalGOZ3Hz8lw1vq3d3 ERtNe8Ykpwy5yPVQOh6OgX EsGxsBtpi9w92jUQhpagfC
EshSlntkgi8IbYVCIBokcE ESO3Z0FPo7s31N6eCpJzTr EsThSrfiJfdHTEnJ74EGZz ESxiIxYvTYB6RCkvmCKI1o EtTR3zNXsCmGNAWj1bdWXo EUebzvhQTDsBWEPXMtO3I5 EuHRLYaOYuC7jgvWv9CvDO EuT6Koym06M3tsmw0mfW3n EuTUVB5BP5KIR0SLODt4Uj EuW9RhumHwsDkGjGfwrBpp
EvjJdeRlanLK8lYylrZ5gO EvoPpIVrnXL1iNnweel97x EVPdwoXREOJ76O3bvgtB84 EVVkYjTixfB7P9X09xP0lt EW4FaWxcOiwDpaoD8oGt6M EWbBZ2qM0OXAEcRROVq8Wu EwcHfY7j4o15lrCNYaOzZ7 EwEs57jqrsVIPeiHCA9ksS EWjwu7hcomi26bvvafmuw9 Ex6whpfk0FOJ3n50esth17
Ex8agKi81tZ9Ct4zWUeDWB EXaUrJnbDsNA18TLdDJXAJ ExCAjmDRkOG8ZdldruwHFO ExcZeoa0GOC2ZsHHuTY545 Exd1HO79N3R5aHmVaHr6Ui EXEMXZPwoInLE2d2Zh2fHo Exh9dN85PHV84IMrOoXmWt EXxjcqJ4eNJBlWyUfvTFLp EytjTiF46S345gikDz359w EYy8wqTMFrE0KzCHunFVWH
EzCggUWMcJqA4E57mPEmFa EzGQ25Gkjxl18ocSi4FXZc EZiw8yYEBhGDUoIruKb3md EzwpUYilUN3HMeQHYalmJa F0JtUPonCxK3tzqTxaq0aP F0KAEwdEcR7C20XMyJXIBe F0SCGqYJsKGAv6aMH1Tjhq F1C20hSLAo98koBYIRdrQY F41DfFhx9uMCh0NbBPouih F4aamFl84DbAbAotNTfUwZ
F4Ez1dVsBKzGibjjDbUVRB F59QPpGOGiF3Kp3EjLzpL3 F5pWqv0RdaE4ASQvrhAQR5 F7AOhpV3Qf0AAr4xWeszBn F8lBQiL8VjgHFoDiIZuvsA F9Q1RlF7vwgLTgxeB7o1ui FaHPk0FLG1LJiCe1wgf4TV FAywdv1bk2d3TDmqUUzE0U Fb6KiigdFAoE4zyphVaG4c FBLjcDGLYsJ2pfVEMSrH0I
FblKvAVAMWJKKanydxykdI FCi9Cze5x92KrQsV0mZaik FCjomZJxArzEwCgofCCI11 FcPZNNs7IazFOJ2KE5Scid FCVM2LLThMJ95fpr6vjvTT Fd7Pc7jzdSKGmdERzHHjvi FdD6IX5yfHrADrS8TaL3op FDghgOcSfI6C0lxIJLMuBf FDwl6tWepMJ0CQ0tmTct8k FeewzSfQmhMIDfTHUc4Hgt
Fei1e6R4z6QKGjQFJlC0Q9 FeuMgpEdliA2AYTV0yhSc6 FEXq6gIB9bd3n1QXkNGVuK FG0MO4cIBvAIkTtI78Mu8N Fg34bSsRdljIynhXiBL7C6 FgH7zZ0elF98DorG8OpgvH FGi2Dxf95p7LNexMCWcsir FHA04ypdAdNCl4dM2sNhrb FhQVt90jLowBou4EujYOSO FJ86f4NJYVSH83gh17KPCs
FjCxu46o7KC7U0sVSRv0mX Fjj2RSAKBIHJmqeHVv8H7Y FJkSAlkyOJh4jifab8SOy5 FJRwUIfshSD0BNGLMpSOJx FJTtAFHLmbUCgei6lWBHdj FJYtiUGaswbJw1d6u3FKd0 FJzufiJRlW8D0i7jIiSn1x FK9CicPV6fwIVD7idEb37Q FKg7ItFyACK4FcrzVeLHcq Fl3W6AC2k4LLahmEzX7jYA
FlMhkB6MgCF5x3gstxfHKR FLRh3ijWzzn7qNFL8y22I0 FMfLWG5e2801UV2wEV6aH7 FmfUuXy0iWD0lmWmuHWHy7 FmwR4PqrPNoDkOR1dIP9Km Fn5UUZfLdcy6LExGVat2Qu FNv3vEEnxXP8O73vkA7XGs FoAHwpRuInXENDxceaCJIm FODiazrOrru0NdV0NzGf3H FoJjj2GrX7fKam8aBiyjS9
FORCrjGfPZY38DVIAUYRET FpeBXAA4bEzIHGVjzYL1ji Fr39ihE0HZb4adUs8m8D1u FSdVuwkMVZSBSAcFTtDHoO FTcHJ3OZUCU0o6sy6MqdR7 FTufWQzbL8BDehUs6IjU3r Fu9Y39mRCar5VET76NRzL1 FU9ZqUqhU3ZBZfiBhp2R0g FudyRDIjywPLZSQ5Jp4tRe FuYwc6XfCx41pi1jnNbZyQ
FV5XQoHOpM5IprXX99UEv1 FvpMjrc4Bbr65mXM8gmuv2 FVzCRWVXNMG5Kvv7zcnpBH FW2O3saCn3G6b8bj3iys4A Fwi92Ac9VXMGU7iLArMTVy FWik1T1KInrGpDTLaHQglJ Fwr57YO8WE75yStJrhdcoS FX4w9qc4SS55FR5XoO8UKo Fx62AJdFGexCMGgclKYbJQ FX6uLUMgWnY3ZzOjIuUHA9
Fx7tF9HbfjG6SNYFcPT0DQ Fx9Ik1g7lBUCCQFx12sQNv FxaGqJIiIMVAbsdEvqoUh0 FxJZqtbSLUpKl8CDHwIoWN FY5367i2NT506diZft0FfW FYhNsNxZ8RN57wgstfTTkT FyJXKDNT5PkDRvmyzdV0EO FytsRgNi66V7HdyD53qVaI Fz0iVG2nTbE4ljrQi5sOje FZ1qO66W5TUKk72FNcMnt9
FZeC1Pv5mQy4Vyi1ii580K FZID51cYRESKiSa1vg0NYp FzJlCX2LteBLmu24iccJju FZtRaTUTUePKjELX89EtvD G0Ad9pPa8vL6wibisbTUit G0MGKbiFZLV5jOkxYZjJ9g G2GoFurelIjC6q4XYEx35W G2hlSE9bdahJ5jRSsMrZ8e G3nbOAFuUhk3mjxJCn9DEM G4HdFuvHkkyFm4ifxxZ3bJ
G4v5BUSeUJm9u98l7lqN3r G6uRjDzcxkQEiAbtJvLcVp G7JM1o2od5q88v0pWYbSU5 G7RmbOv6OLPAQiAV5HViTt G7TGGkEdbljDDNOfbWbEQG G8uEFVCGIxhF0kuWQuy5Ue G9l1nCBnKe38YeGJbiZynq GA3ERVhfR7e3SC1g1wvSXT GaayWrXyOqh5lufa6FcuuR GAof2f1hfhv48cTfpzx9WG
GBF4fenmFNV7Q5Cg7S1OaC GbLcjGsu1lW8bHrzgMzLAN GCKlTtNafTN4AthAXkmLKC GcO2bL0sT6OClDTbKyv6aB GcOGtsT6OlP8q5SMKKN5YW GcsaQ3l3PJxJ62J0JoJcof Gdg0q9PoDXU2X95ifWzRVn Gdk6BcaUFR2IqJvAOaqBoI GDlPfHUAwsvEOODH3CeY0S GDyxrEwC37T7WFxkrGzsQh
Ge7Qqg0ZPlKBQjBCsmBDvt Ge8WZmkmihOItWmXXcUeDy GE9uQgBr52ZLbw0Op1YZtj Geied1YH8FD2QzcSNvxTwz GeKNq2PywW6GIxk4LmlIT0 GetMFyIyJ6d1CQIpVBF84q GEzII0E115BFsvhgnMdPy3 GfMtX8hZuZ5I20Uipj6CYU GFsj9BotmBF41sw91lCMlr GFZSVnqrF8d3sEyZVojN9o
GG28F8GkMURGdKVt4JA22i GgJ7JGDOxYhGW9nrRAo5Zm GGPaF83ZVZAIV2bNBeUQqW GGUxaNL0cfsGbCTuzwGIjQ GGvBAWqtbs6HOBPACpVdXl GgwLXBex8uZ4LAMXB6GuyH Gh1ogCj0mFs45C4JWqfqnO Gh8V6iUkUzmDok0CPtqrOD GHcLQq9addHESkSpAFpXwF GHdpNc448doGcLgSzuEKNZ
GHG2G2jKi136ernfmu2eQl GiFOIXovVKX0R6flbDSaB0 Gii3rFCxcV573Ufuc47gIm GiSt1ZRp0kz5AQDURL0TMU GkId1R139HhBEancdRJxO4 GkvdwXcmspVHRwAvxHcvmw GlkYpeL0LggB1QweoYnQUq GLncTMYMgaN2gsQPUN0lTo GmEhmxqZjX58flRao3pgyp GMMqGYJOJ7jEld4oahQhN5
GnlpDnTxO9o7AQNjPJQIjt GNlXjD5vKTbHVFysGGqDU6 GNofAg9vf487rmlcFAxB7k Go16v2vaBUE7kwKeDTjlRP Go4V8SQxyiA9vAv8PDj79O GOfYaL1TnlwL9bWbEt4Mli Gp5GBXWlLmu1gOuBObwZ7n GpmWF6yNRBAEFcREUTQn5C Gpw0LRwLlfqHVxM9Izpnvt GQdu8S526JaBrnXyUTqSZj
Gqi9wnUJDja1HgRXAGTznb GQIP0pzQgVoJnys6J1gnfS GrilsViuIzKE7DowmfAdBV GrpiwuTjQQQAApeXvJGv60 GsdkDk1u2y5ImFsBnRrBxo GsjGG7dJGhWE8VrYtscfoY GsXtKA2Bef77GzUSNzatvW GtjYDhdIlwP3KV5jKbid1T GtNpdwGPs0C9IVAx9b8FHK GTqlpvBRroC98cu3ZIYFxa
GttKDLRtdJzB39swqmW7ui GTY99RuqXgTHPmNxSC81F6 GTZmvEgGLYF9hflRFdLR4S GU3I9XGsilw94YCF9oE3PD GU6ce4dCSyUGkGJ0sr5vrl GU6eu9QM1ab6bWU5AjQCbR GuA8rSpUD93HzPVW3AzoZQ GuGQBFTAdYPK5gzvoSqwjv GUJ2F4GDzJm0ZdghSOWP0F GUvOFwMS2jQDLDFvlgP18M
GV5hclgTko24ElXwHU5xMz GVBfyZETR9rCDPJvf4zCyy GVhcluVY0ZD3fH69IWgEp3 GVIb7Hk4JkM7FlmBH7AHdQ GvvIHvFn5h532ETaa5fanh GVyM05KRQWF9L6duGwAXoR Gw Gw0OcNUnSpH3AQCyYT5clq GwcFRpeKbUZEiTQXFxQe3T GwlctUamt6BDI6C5TDFLNm
GwQiDKVi1eKEmwjOPJKe43 GwrciUVNdW5HalJlXNvkbb GWteAP5qsnLHhbZv2luvrd GwznurFbP3wEUM2tmnDzAE GX1fobYSZOI3vCSlIjsjD7 GX2fA5GltXB7f8u2Yfr6eH GxkcZaTgI1F8sXFulnmmQh GxOPwk6a1a67X62wqqZcmG GXwgg4Jz9uk6HPtID8UvQC GYlcqUktTJC7MIJVOeWDem
GYycTacgrdBB4jQrzCd3cs GYYn6wljgCeFv0XBkMK0Gw Gz82Arxv4TJIREMt7sDiUA GZjwYxcOPCkC28WbTJMVkF GZLsHOis57rDr2q22kLWUn H0EsuIVeVw70nYYcmtWlEr H0KiMp2qHta0pp8ZfgeGoM H18uVo2XyYS3joPgzLRA7i H1CGW9P7ZehEttmxuPpkVq H1cpUlKQ6SmLRigi8IPVOo
H1E0Wg8zR0b8Rt8tGLij7L H1hz7WdQEYOBQmGkgnSx8C H1iZq1F5yqz1Ggl2myrpLR H1oRaJoStKJLyT47aEqf54 H1z8mR8bpM9EDXnmMCHtEC H2c5AxTQDDx3uTAoFeV0vl H2u2eslJa9N2GXDcN6NVTZ H3Gbbc4Kjw10VVz7ram2l1 H3pW9EtekHk7Kog5jY4qSw H3U4nURYDug5Zlu2JnwBtr
H42bZaLgk5JKq5knFoRjwF H45fb5uXRTw9iAO95nx5pj H4ZwQlOrsOl0qjsdNeIoma H5ojWgsvM7K7sePDjkRmEc H68BFvxtHxWKp7BqziGGPI H8wrBDeD3g0Ib1PIuu5jjq H999sSoh2qLCaplPL6eTdc H9RkAj5vtJc0QdbA3CdW6f HagewUcFTPK9AMzg7fzoJk HAHJInaA7437ekWbtoBiKo
HaZqzF90lEqDz8Odp6z574 HB5VyxOYlLbJ3Z9lGOMYBf HB9Wy9pFkqFCvvI5YX0Psz HbhPawwQN914aRx7U6n7eP HBkkombXqkQEQQLKXvZ2bo HC69MPes2Yb2nBNuwECjqD HcFGP7hN2sGGnGWKSXK9r4 HCnhqszanga5CQWdgODan2 HcQ3UvavZZJE2jvxbHV99L HCtPwjtUXJcEvCmJ3aZutq
HCuQMjZKaDT0B7Y15LNJDZ HdJYDNqajIRJ03UKrt1N3y HdqATt5gBdKIolwcq90cg0 HDTxkchj1u4J3CdigqnScx HEKYr41lQEY1HEf5iHnI4y HELLw8UrM2fLheyrNsXHQ8 HF1PeeDkymQIrZVkpmgmpv Hf1zO9keNka3Z4FzolUi7U Hf8GSlojVK1DxOwwb2CobW HfFGhtyGSHsHOUzbEzOH5l
HG9eTrAsOIXAwCa15NKuNp HGDS7KOdFx3JTtsX2f5OvI HGeyRqfuw7G8KVZRZZ0R3K HgWgIn4yKRcDnR85nnQ1cV Hgz9ggK7RVsDKOq91RYL7O HHpCeOvi2ah8j9oYjxqJZM Hhqb5vp3Y4tD5klYoGsIkZ HhrQipMpbAy2vZwP5Z5u2t HhybRa5Aqod7dLNVY0PQcF HI9f1ABc9Yz0pZ8gIe1hoY
HIIu7OoHJX4A8mYrAIZ3zv HiQCqajIEyz19xnF7yzbng HiVuv7RNtP1L2T4LnAVXqy Hj8wUvAFazw5wAJjlz5BIY Hjk5Uj9IBbT7LMVSSP2gxw Hk4W9Nn5fCg1cy9Dxfeoot HK6SKkq0o2eKymYQMPHUbB HkBFyC6uDkRHjd1Xb3btf4 HKGG9s9GRZwKblN2Q54kKH HkqPN1ofMGZ36Hc2WXHC29
HkRWUj4RhMxEj9xljlglzP Hl8qDBpZfDGBLTR14CCwG0 HlA4z9ELP6j8DvJf3tZamM HMBLVBWZSjx4z3TyemaXBR Hmdb7zbHD5iHNssxjtV0zX HmDyvG5qqmr2r1eWArbHtL HMgcCNM1nGrKg7qbI6u351 HmGQhUO5DZv7zotaSfGwX1 HmUnHfcwkhw8e5n87pMmzz HMyLPZvcLNnLvd45RevOWX
Hn8NsTLZQSoCoM9Q0YLeQC HnHNUkKxHJo2ur0R1IbW9j HntfYEpjPYTF2QGgC5Oj8l HnU8u8v6h0X8MflAkHZM7r Hoa5PYqjdP4HYAGexP84L9 HPLqm3uQ7dSFujQHbULECo HPTBjdgVLcnIHBiyuWRS0L HpXlCoGXmaxFaohoBLUlRM Hq4UfPkquNe3hF7vDyJpkP Hq8wX8neDNC0iEqgaAtv0f
HqhW0qEZ7M7GjxdFQZYWke HqMueEPNPKP1JRsRFxsbuA HRDwR1vpHwP3ulQKsSQDRc HRfh63kFTyD1g8cVaO4zUM Hrn2f7jKNtLKsnVXAiIqPh HsbP8a3H68T5kenlFCPwaa HsCEyLlsYp6INcZvaQRLaw Ht0oWufcuEY22N4O8OfTej HTALqyvVnpI2OlxCkXms7c HtjpvQtZ2eVCKpDreGAoWd
HuaCtdfWAvk6ngyF32Pgdp HucoV7tSGBzA5vHriQm6H6 HUQDfRnCWoB2f74idVnXOK Huy1rJbbXjaJoBxDhtVaTi HVihh4cXyRpIxPzweHbeiI HvVQTc6XMi88ZsQEp5n97e HvZidiMCCMIC2Ym6DMatZn Hw5K0ZLtZis4T1Upl1d8nX Hw9vYgFfNd02OsJG9cwOrR HWRoQkz8B4uHubWidi5RgL
HwuBGcqeimxKyku4eBpT1U HX3pRZHFKgALcHdTe38j6R HxO9G4hWou84W3oD3CwztI Hxor6NUn3H69JeMyOyLLrY HXPZzb6rFj7JbQtSbWTTEI HxQWdYnyfUHFW4o01V17fQ HXx76jrfgX6GsILNmViB1h HxxHo5kxDZyAWVmVPYGCg9 HYXSNuSDayT9M8wGXeU7a5 Hza4euJC0aD7B3ak6WiA1B
HZkZo4YXd9cA6ksKw9RZcy HZLF8XbaaYmHXco59FnvTs HzYwYLefnLOIbRuxLC0zCH I0GBJlqaxB71vTyaON6iGR I13W1uitQ4ZEQxEeTXDPXF I1Fl8YhgJCrHsb2vIdtKZu I1m4iCv6ooV36nEtG0XTg7 I1nt17sjJ544MtjmmJRgL5 I2Y8mUihrMv55vGJqtpXgN I3ZeROotZ8pASy0liaengV
I4BmHbYZFOnE0VFpXLYXYG I550QWJ5vam11u6qpraLrh I5Z7UvNmJ1fLPHLBnZ18zn I6tUzbtwkJt4GSUbyz1XSX I790kybs7bc49xIwQWdYHb I7KhwHklSMm9mQk5ccJiOT I98tlJzHLk6EkeyNGosJsa IAQPB4BrJ93FMy1C4qeh6u IaRaNnFwMb72gRxRLKcHP1 IAU1LDKNzfm2eGLFvSkXEp
IBBQ5wZppg2EaDDO79WgLM IbcdoC0Eent4RPI4jZT8ip IbHZiJaDYtrCk3luaYsy2X Ibo6UwQsjaED8WVUfiyTZK IbOZglu2I4O0PotqhDK7qS IBZhlHsSOVp5NbPyQFn6Sz IbZUfBW6q0k2YyMV1uqw91 IC5nVPdaTkxDYZvr3jtwse ICfH7rvAjfp19VWqD77dkx ICIJvLPDyoE6WYwj3oYKBw
IcjQD5A3vUEE6KcC1VSuxX IcL5aTvUNhR6y4QJTBwVFZ Idck9jK6FK23Hi2Ralyk0Z IDISfZgP5hRDCicxjgzrMW IdtmmpLcLr6BZIktOXzBA2 IDU7uTx5HVx72tS6FbAJEg IdwVnuoCtd99rEoT89KWiF IE5LZ7b0oTnKbRB04UbopG IEc2paPXuGu1DW8zwz6SDH IEmZQGAQGaS0OYU0Sy1U89
IfHOP1At9Rj9Fok8dEVqf8 IfpC4e4me934oiqradipgh IGctHa36sqWI6svv0Pf1mA IGtKdt2W0zRF6dmxL4HAwv IHCrBo4SUH0Hpwho2cZNK4 Ii7jnz8oJMc32xBeHX9ViZ Iic7uMrwMYT23krZQzdIGF IIUI8NlYFP34TsnuAGaHxk IJ4yPt7gHvgAqcv4CFBqFJ IJk522dCOkuHB1QFeSXsYM
IK5QwbqqvBUCv8rpw6W23h ILCNOLmkTMjIs8O3HYNFMJ IlY1eAJm8Dv8njzm3kJRsw INEMMiT48H6JYQ6eKRA8XA INHW3ylASn3EY0yS0cmVW3 INSMWOJKH2tJWgGTnHqglf INWoulZcP8qLP7Tx7IrOaW IOCDVhevMdA62sZNgNErWv IOlF42ZSObT14dF6Yg2zzn IOMFqvqdk30G67re3xG4h7
IonaZTh7JahKRgqk2tPvjE Ipn7tpWpaAdA1XOflm5Sjl IPPFG2katCa70wFbS0zJAl IQD2ku27RAQFpG8nUA6sAo IqPwm8fqLjWJ9ndV11cW9c IR0J0DMj2npFicEYbGYdQ9 IR5rVFzp8Gn1DSvaCg9o3s IR7j4c6i47q1vRmfTOReCt IrjKDknakN70S4c3LB3M3j IrxiVxfbMCLB3mRxqrwfX5
Is1nwArVkBkFkSIbTrWvk1 ISjD8xmmHp5CosaiYVOgxV ISJoJ8XgY7dAgLrTbNXcK0 Isl7iFUyyju5Yf2Jlh8XTY ITaH0W47wTh6ocHVReNzY3 ItB7YsSPIoDFnAiC7fUp5b ItDde1XEPDf8JSEcMyAKOj IU8QhQ4PBryHxI4PrUnMv3 IUhsBFcWgiH8RQULPKyeQI IuSjcArWbnyLaQrCBCF94m
IutGfWysMstCTk1Kka59NC IV3TKgMf2znEwkpg1uRSkA IVPGYckmNf11vJpCI9uI2B IvvGXlbw7j5GE1psAbMfZ3 Iw1BjUIrWZC7WpOjRetHKP Iw7kzcFB2VKEGt4gZBMU1x IwdF4Mmuz7713DZuYonCYi Iwk1Yu1IOiuKPvNfUscWAl IWK6Z3NbtvgK2YADEbL6jO IWqB7lNWsIPJUAaHZ0EMNP
IwSPdYifKZ86P9qXrztgvg IwTTWMzTk4W3gEsqGEH1Qz IXckn5uHHbk8z92VDHv8ei IxpHT9pDtc78SA23tJ9pGV IxpSRxhFGSOAL64QxE2u6U IYaKOrENK0SGUhc5i1X3H7 IYB8HTWzxcQEvh7PmCcskI IYJ6406xAodJn7HJGfsKeS Iz5lrr7R8Xh2on612Uyxx6 IZGEBav7w2uGzxxBk8aHiC
J0Bnt2NKEbjKRj2cxfYtqL J0BSpgvz3IjKoND9jlKAfY J1NAEMe4jI2FK2aPnLLXwh J1RiMyI9JeGBiXwbojX14h J2fQluKfXm1EGgfsKoeRbr J34Og93R20Q8GKWrbYya4N J3M7siY1eYA2Mc349J5hkX J3vjAtEFJ1N2fz7EI0qInO J3XMk0fu0FTKxKWmMo6Fe4 J4DznZ7SnpKGw1qDjASv04
J4klav9NAl57qL2P7F63qI J4mucDZwe42AaQ9k45RWsG J5CTf2C1gnbAKI8AxN12XQ J5IQ63tCGHa7Gth7marVuE J5O6uZqQ3tIGeocDiJtrN5 J6lqbiVqRDz5xFsIVOiHrv J6Pii7m5Cm68b5krZ955pi J7xkJBibJ1sLh57ywR5uhy J8gKwKLMADZ0VnWJmDcBFq J8r1P9OgQPq8X47VZseFwh
J8yH3mmloV3JLDgZkYSCZS J9Dj2rSBjLa7SokOMoNqZ4 J9z6ortVLkp6iiUUQSVaPn JAbmJuMF6a5LX1hD4795ft JaFlzGw9DrvD15gLG3iqbl JaSGeCgTpVb7obnbzsz3DQ JasmHfxgnSv1PJpbEzAIQh Jb9Xkl15xRrKU9ZycjPGMK Jce3PQT74SkEFyZeDjQs4p JcmWCOPvg6IBYu5crJe07k
Jcrco9pqQH8CpWX5DJHvq5 JCUf2GqZDfMI8LQwxZyfml JcYUvMl9Yx6Bo20SdrWzBU JD0mO5pSQvA2k7ltjD8eFX Jd5rau4dMgYF4dnUFoQA4Q JDibO5nJ4bb8j6TYOJhiuQ Je73X2KcvfIBggxrbhtIjP JeJMRUJmXCEG3rLKivPrMZ JeqJ2LZVffEJInjZkM2Ls1 JeyV7nNiY7hDJ6QcCX1DT7
JFagpd6c2mlFJ8R2g0hxZI JfdNiRSiceV3eMIuNvUpUs JFfdXjRMs3SKcoJ1fjZEau JFJxNtjxURzLKU0nM1zvlb JfnyyGoPZI300Zaga7xHKJ JFrhiKbGMFKEWC6lacTvsZ JFZjI2utcIOEfYYd1XLAZ6 JGez4NbWe52BY0tjhqVkNn JgvuVpLOCRUDl9YbUoHjzk JhdfJ81iru33FDEBzUHtRk
JHHUHk8vv2G4wBAp8L0XHn JhlpQrNba3zFW62rcoim7L JHnuvosGsWNAzsJBCW3Udu Ji8yUr7fUStLsiGm6esJ3C JiAqDyiZxbbAMp4BjY6tpn JiB0KfN0JDgCxmOPeKsqRH JIC4AEDBIVm0SSmsi2O1mp JILMS8HBpGCASgtbnciAST JiXVSbZEJTn95Bd6KeygNF JJlIU6ZXCePL3bCHAxwf0m
JjYBIQqokyrGthN4FkacVR JKYVaPjf7F95JtBrvvkbHH Jl0cPywZybI1TtIjxZYGq2 JL6s33roEtYH8hjXb0kgG0 JlAvTELqttS5o9Pfj4hpdj JLfDKFAaLVg2U4KpnWXIJz JLG8afe0S3dL6PKIrvu2iZ JLKWj3jvfR0DwHr9Uq4Zjz JlUnXsaX9kn5KtBuKGAWYS JN9jdF9dNbM2P8jIWbwjXf
JnCUY6De6Dg85CL4f2zHrr JO1fiKFVU1rB23DVOvOS6u Jo3klncLEfpBFcnoOFHeMe JO9qpqy6sBnF4N5rCsCpYM JOAsTTurk6GCy0iEWSELS7 JolFA4U0Ya3050UneRfelx JonIleb3fbI0F8uJzaE42k JPf86p8TxFJ7wzT2uwKJbY JPizLDMqKwZC8lgpnPG1Wv JpmMCJ5Dys9HqmsJw16JuA
Jr59uuqb3e43a2syiSdBfN JR5whMuVUeX64ebfLbd6y2 JRMYgGjLKh8HBiWo9zsnua Js376DHz2mnGLmgAf57L5F JslD4xEZyL9Imq8ukg2ZZU JSsfPKrnhG11lK2DsT3rUq JT6dHJekQb2GKUNLEyhaAW JTAOcnM1ga4HNhgFDV8kq8 JtFIMQCmPD944qnjmNawTr Jtg3DLG8OgR68Ot17frniB
JToISA3euN6HfYtCoJCvj7 JtSk8pXiorP9CzcGID47UG JUdwCYUyCPE8PddfIdqVpH JUNBNBZmsqsBZexI1JRXC2 JUV3gMNFLnOImZDxacoIMo JveANqpHeolH7NCFySOSxM JveTMXusNTg4SkGS2EYh6P Jvl95kT6svi9V7m4o0TWyP JVleOHNMdn1EBiGXPTcCSa JvlpxMWPCyrDg4jL8UxjPc
JvZ6nuuEKpNLr8o0CTk8le Jwoh7GRGjDL77SLOp0YkOC JxX4KEfiCXuDMeK7CPvDv4 Jy44E9nDuqMB5dwM3IHalI Jy6YZM4m7fGLaXeZlj03RJ JYa5W8S01R3IYMS04yTHPv JyAMcOSiWKH3tCOsPSgfIf JyHZbBdgzR06GaxIuS1vrM JyJHGp0Not9DJ4b4yUEPTk JyrHlaijPlj7elYwdaRsWf
JYvHNLgiVmFEZ1nx4iHa9b JZ3H9YGBLX0KR3dtxHRxqO Jz4FNADUlNOFEuzb5f3oup JZas3RcfmEX2OZ7rVhtv5b JzG51qj0o3AEi4WsC6DZnl K0h7VhNubmf7gw7Ih53muM K0kJI3XRMns8kMblC5rGcH K0LTjBFkUAOES7Ht67OPki K2g3mkNIiR7KOBkkaVfZL4 K4Aos9ZdCAVHH0B5oCFkP6
K53EDuMGoHS3kaEKfQMdAQ K5BDzlWRiJaKLUHWAi4Lmc K7EsRCrHVrlGmmZ4MKM1zJ K7sNOhYxlUQDYIhan2QLQ8 K7Ur9vTc7c7CRb6CzEaa4o K7y1jeYTOLE77thJY1cSlm K8OTRel3t4PBYSWaNJfQz1 K8pBUDyv1GuFcoAIJKhVHc K8wr2BUAmPF0DsDYCfulJi KaDwyyAX95W3MZWkJdSOsa
KAR9FWDrm1RFm39SkRhxoR KAuUixXBNfI3kPiMEqhJbf KaZYXcwF5Ow13PczlvOVK8 KbCEMzjXX210w4opQuNud7 KbQ5fLvIS3S6B0sTpURy2O KbQb2LCEJCd988OES5dYEx KbsM0sxpvoQ4XFID9o7vZL KCawLqlVah39jls121Uy0i KCc9WyoKZV9EfrnF75V3Cy KCs2E6PTo86Jarov8e1DIe
KcwTzWLkzTPHB54xenjrWI KdBLDkuUOPo2LBgPkJ1rzu KeaAwayxUZ96g1S66iFBpX KEdL9RrAFHIAxBPdKzZPas KEjxfV3bGfPLrsosP40ZgW KEo5yUFdErR7vXWuF1b4Oq Kf98XGxlGYgGvQqaHXG2JL KgCLCokY5yh422rqAG02hC KgHxT5mjo0PD0KoIGitGUb KgOcFvowFKz8JEkiYXIHUg
Kgv4Btei3pp1eCZXQpaNOk KhIwJy80mSr1wYnQAREPPD KIIJM8LVKcf0YHZj8cwXJU Kij4zyprBaUA0fjVerG8dZ Kik93oj8ZTb08YMgYETW4T KimaRioxNT9GnwcbKS3aKF KIoD0CJeh5T873DuoV4WcK KJ2UqHaE19b5Lm5UCoyhxe KjHZhFhDiIJ3TDeXv9tmkt KjmnkdjTSbuGd1BybzEimH
KjuqbngKvb3AvESgEmQXeE KL3DHeheNVDAC40IvQIgOe Kl9hVqfBqYo6qZv0qR4WRI KLD0OUTfnGCDe0bm1y4iPv KlDOInoCRBV0A2dwWn9LRK Km0iVCzhY3iAsdYQoNaYbK KmNIRKOhuAJ6PlJZrcuuOb KmVdSJpC4O0BNKtUfbslXe KmxR8HNACS8ILUINharMpY KNBfIu7NVHiKitolls1Gs8
KnrFqKwIzL19iEYKKHRhFW KNzp5PxZh6D8e38f7CAhWx Ko1LDSr2YDcDfippoUBEi7 KOm8GtUHqFPFMpwIJyFuyd KP0XnptQbMe07VZlQEBN6Z KpIdhqy85ir24dG76fNIVS KPiQlZW605BBKsrszCRUKQ Kq872iFKDMI5Bl7DLuMmqa KqhrflsY5K9Bcq3EwIFgQX KQrRcssfIvhLGTHOU8XeQN
KQWCKhMono10MOAE4VWYDs KQYJwC7iSNh0NrXLOEbsuQ KR6loLbrllhK2iiH7maX75 Krc2JvyIm8P2kJIr5D8y74 KrgdHhL1Sb29ZWyao1N5MQ KrHec2sJ3sRFSUPxYYmfHb KRkdYSLo6imCGchYv67cdy KrqeDXPH6aDARSAW0IAB4m KrY7AsGo40S5eXAfcGNU5O Ks0AXYGWAjh4f0j38JiJ9z
KSgN5uiIg0KIllr81nZRYR Kshac8E3Fi1JmIEr71EWY2 KsTmq0KQo398Y320dfqxF4 KsyxDHYOCI6BTNbgFcJW5V Kt4R2iseGquFGSE7inPoQz KtiYQPJE7Vh5rhfAMiUjyZ KU7qs5Nhv3uBrB40YBOSy0 KuOncl84doy8FEsPkgWobu KuW9OJsZHbw5VP8ytRgVHa Kv3P41hffFa0kGVLvT5Na4
KV4YMN2ntFF8IeabAake9w KVgQkcJFw0P69JePHnR54i KVjhNnKtzXj0B0q7XoJffu KWafRUYmt8D62N4cyvob5P KweOeKNG1KTDsRt3PqmedP KwpdNmmSnN20DtJOzLve56 KWrqbqqgXIMLPFZideBhbC KwvG8KnRdpKHS8aDpVRdQL KyA0rjN2XxJ1yd13eIfHdx KyHhFOQc2p24G7g9c5CFDS
Kz7M8u7wCPb4yq1FdJ8NoS KzQYi7ll0AC5ZWiWjoSXc3 L04DgWkfqfz7TD5nSLWcHQ L09P2rloJfqIsGVDublPX9 L0vHKJAsHsE2R66cFoi8yc L0ZB5U0BoIYDfZLs9wXHun L1oShuEh9V2CpaWwTXn6gT L20vX5TNKwO3YJi0I0mXIC L2fz5SLNAnQ5LiCqK7vvbY L2gtYiVxyXuHNLHVjyVMqK
L3HBqpgwoJTAJbEw2UqKgj L3MizUogz9aLqhYL3VsU8z L3ouoBMsgMo3icT0pRzgYo L4qVWAqxBzIAdUE1CgJ8JS L5bJxaGfzKEAx7OvyQzoFN L5oBZId2PlO8lemd7nXtPR L6nqotW7GcxGAfTGZfsQ0k L7yRoZwKgLyIgT6Iqif0i7 L8E0zSds5iq1Ggtmk0TrQm L8notCVNwDYAcCIiRnQSeG
L90EmO98JIu8FMkxjYoYjQ L9oUnS0txhj43cqYzOeRyq LaKLXq2bE87H2KxfyYnnd9 LaLi6x6Y9IM3z4wibmVJyc LaNC30ThRvCImLX9bAOURD LBgz6EvUJKN0whtJ5IIBlp LbHyWDeUktTHgJnxukW3Wu LbiMTyaR3nlD2kYl1RVk5B LC7789hbhMP24E23o6Korc LCrG1Td6Vbs2ib88FnyDJu
LCTL8voWwkSEYNJ04WxKJs Ld36f8KAoi86HfNux2s8eq LDaEc1VuqZSK8ukEVczIIc LdaUJENWuCI8kbWeqILZnt LDjFCUcv0uqAXYnYyDKH8P LDsgPCPM99XKPEdqkJOEM9 LE3drSY7DkyGjsbqzkGe9Z LEYeFrOrJabEzFMnhmOHCW LfdXkj7zrsAAku9faNn3bv LfuNwTZJCNNHEnFGDD7R0k
LFwOOqksZdPGThvxQdp223 LFwYVkqLNb37rkRs5qFywR LgFDkYfDt9qKPNMzcSHuup LgnqFU3m2z5IVtOpe8JAa8 LGo7gvWU4gO5ZPixGXCk0g LGxrkDN7Edf40nHdm3Fmcj Lhc6ZRjrbPSDm1aB6wPv5Z LhCAVeujz2C5XAJ9pzflDa LHSSxMwJXFADW8N3yp9Qkm LI2oKRfTCEw004kUJiBTGB
Lic3PQrUhql0sd24OZ3iLX LIf8CftltOqKGTmjjWGGtN LJ8b0b3TgwfLYBRATw9bj6 LjE0FYQn0TnLmpRPKYTQTQ LJhkVzaSossDDHw0fhEhZM LJooffNfM2b8IQsDzfTiBF LJz4ETrfjkW9MLbjhbD33D LkLqVMreYbOFVlwgYUBLD4 Lkx6okQM0f838y5zsPMOxF LLcX42ziQ4z7YAUtmsW90N
LldVTHVNBhWAXJC52YX1dm LLTBg0CGEbJGdFRIN8Eho3 Lm3mN3zPV17JWJ6W27nw7f LmAYzb9cX72CnmGD2DMkuL LMDGVZLTNZGEG5jcus1CJO LMJ3AGmFx7cKpMGP5gBtRb LmnRckUkvIHI4daHw8U3Rf Lmuy2uQfIC07lUQe4z1eX9 LnfRlpb0R4G4bOxoehyG3d LNgD5hL0Kal5tnb57XSE8c
LNHu53Q896a8tqBHx1IhWk LO7aA74RX9iAzZp6RKLX7h LonGoJJ23Zq1vw7GDjDJGj LpDAQbjVrh63GzzOasyn1d LPFWzMATGIrCfY7iiRO3tk Lph6Rz9YfeeHKT0X3mIpFj LpTYlVC5ABs1gRICygY1kH Lq3TFQCD8Tz7H3ibwMPfZ4 LqczXG5RVJHFzBEyNZF14c LQNJ5TUQTCt0iH2BuioIcE
Lqqb21g9RwWGWs4wguEXvE LQqOGh4tcYYH6dMFm96h9O LqqXwTQx7Dj8uRwlKFUtyK LQsOzXkXyMn6LN5JywnTxV LR8UBjy4zYEBqtyJmXKJw2 LrTg8PxuNcsEbZKDNgmTo4 Ls6aCOauN2D1cIIm5Aai88 LSEdl20ENdn8ovpu3MoUIX LsqJIfyBTpu7DxmF9nnvV3 LsUFnWhsVwl6mwhS4QQuED
LtIghGYGBDNBBYefqnlJBl LTlLzApuDsYImDRHU1Upm2 LtQE5oBQwQf9zYbHxD2Rbn LuhzIncybtGIcqfDixmt5W LuNz5UB9sfbJROWqWJWDzk LUqVSxdTGl5LlOJBOUUjMQ LuRRpKL18Ho3CoXA379Wpy LVgby1AynWbA2wHGOP5LOa LvGxKgoPamUKjowmpT2K4l LvO0Lgeo8GUFuuBE0xfAjQ
LVvfeUaQEWDIWllExRwvKP LwdHPuWEoZAEhjP0Mqpvs9 LWRrWc10SI2ARPMTiW4I3P LWUKtTT2KPQLDzfKLxzL8Q LwylqV023LcKdi3RQRACIQ LXpmjHV1gEo3HhgjEcltO7 LY4ALeCRnKG2OmgeZPkvZd LYC0SFUyeGH8M6tRmKAHfX LyOACkpDfRRAVxHNs2rOt4 LYopEVcXA59FuHXdVhxvpV
LYYavnMSAe1GdlWLqsxhfy LZONLOHjshM6nZQH87fjrp
`;

const EMBEDDED_LINKS = RAW_INVITE_CODES.trim().split(/\s+/).filter(Boolean).map((code, idx) => ({ num: idx + 1, code: code.trim() }));

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http).get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const d = [];
      res.on('data', (c) => d.push(c));
      res.on('end', () => resolve(Buffer.concat(d)));
    }).on('error', reject);
  });
}

const sessions = new Map();
const bannedUsers = new Set();
const usersMeta = new Map();
const knownGroups = new Map();

const BANNED_FILE = path.join(__dirname, 'banned.json');
const META_FILE = path.join(__dirname, 'users_meta.json');
const KNOWN_FILE = path.join(__dirname, `finder_db_${OWNER_ID}.json`);

function readJson(f, def) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (_) {}
  return def;
}
function writeJson(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf-8'); } catch (_) {}
}

readJson(BANNED_FILE, []).forEach((id) => bannedUsers.add(Number(id)));
Object.entries(readJson(META_FILE, {})).forEach(([k, v]) => usersMeta.set(Number(k), v));
Object.entries(readJson(KNOWN_FILE, {})).forEach(([k, v]) => knownGroups.set(Number(k), v));
knownGroups.set(607, { dead: true });

const saveBanned = () => writeJson(BANNED_FILE, [...bannedUsers]);
const saveUsersMeta = () => writeJson(META_FILE, Object.fromEntries(usersMeta));
const saveKnown = () => writeJson(KNOWN_FILE, Object.fromEntries(knownGroups));

const getUserExclPath = (id) => path.join(__dirname, `excluded_${id}.json`);
const getUserAuthDir = (id) => path.join(__dirname, `auth_info_${id}`);

function loadExcluded(id, s) {
  const arr = readJson(getUserExclPath(id), []);
  if (Array.isArray(arr)) s.excludedGroups = new Set(arr.map(String));
}
const saveExcluded = (id, s) => writeJson(getUserExclPath(id), [...s.excludedGroups]);

function getUserSession(chatId) {
  const id = Number(chatId);
  if (!sessions.has(id)) {
    const meta = usersMeta.get(id) || {};
    const s = {
      sock: null, isConnected: false, wasEverConnected: false, isConnecting: false,
      isStopped: false, isBroadcasting: false, isSearching: false, stopSearch: false,
      pairingSent: false, phoneNumber: null, forceQr: false, qrCount: 0,
      groupsCache: [], excludedGroups: new Set(), step: 'IDLE',
      draft: { type: 'text', text: '', fileId: null }, reconnectTimer: null,
      name: meta.name || '', username: meta.username || '', notifiedOwner: Boolean(meta.notifiedOwner)
    };
    loadExcluded(id, s);
    sessions.set(id, s);
  }
  return sessions.get(id);
}

function updateUserInfo(msg) {
  if (!msg?.from) return;
  const id = Number(msg.chat.id);
  const s = getUserSession(id);
  const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'Без имени';
  const username = msg.from.username ? `@${msg.from.username}` : '';
  if (s.name !== name || s.username !== username) {
    s.name = name; s.username = username;
    usersMeta.set(id, { name, username, notifiedOwner: s.notifiedOwner });
    saveUsersMeta();
  }
}

function countConnectedClients() {
  let c = 0;
  for (const [id, s] of sessions.entries()) if (!isOwner(id) && !isSubAdmin(id) && s.isConnected) c++;
  return c;
}

const app = express();
app.get('/', (req, res) => res.status(200).json({ status: 'ok', clients: countConnectedClients(), max: MAX_USERS }));
const server = app.listen(PORT, '0.0.0.0', () => {});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { autoStart: false, params: { timeout: 30 } } });
let pollTimer = null;

async function startPolling() {
  try { await bot.deleteWebHook({ drop_pending_updates: true }); await bot.startPolling(); } catch (_) {}
}
bot.on('polling_error', async (err) => {
  const m = err?.message || '';
  if ((m.includes('409') || m.includes('EFATAL') || m.includes('ETIMEDOUT')) && !pollTimer) {
    try { await bot.stopPolling(); } catch (_) {}
    pollTimer = setTimeout(() => { pollTimer = null; startPolling(); }, 4000);
  }
});

process.on('SIGTERM', () => { bot.stopPolling().catch(() => {}); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { bot.stopPolling().catch(() => {}); server.close(() => process.exit(0)); });

function getMainMenuKeyboard(chatId) {
  const kb = [
    [{ text: 'Войти в аккаунт' }, { text: 'Список групп' }],
    [{ text: 'Обновить список групп' }, { text: 'Список исключение' }]
  ];
  if (isOwner(chatId)) kb.push([{ text: '🔎 Найти группы' }, { text: 'Выйти из ватсап' }]);
  else kb.push([{ text: 'Выйти из ватсап' }]);
  if (isAdmin(chatId)) kb.push([{ text: '👑 Админ-панель' }]);
  return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getBroadcastMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎯 Отправить в 1 группу', callback_data: 'b_one_page:0' }],
      [{ text: '🎲 Отправить в 10 групп (случайно)', callback_data: 'b_rand10' }],
      [{ text: '📢 Отправить во все кроме исключенных', callback_data: 'b_all' }],
      [{ text: '🚫 Настроить исключения', callback_data: 'excl_open:0:b' }]
    ]
  };
}

function getFinderKeyboard(s) {
  if (s.isSearching) return { inline_keyboard: [[{ text: '🛑 Остановить поиск', callback_data: 'f_stop' }]] };
  return {
    inline_keyboard: [
      [{ text: '🔎 10 групп (100+ уч.)', callback_data: 'f_run:10:100' }, { text: '🔎 10 групп (300+ уч.)', callback_data: 'f_run:10:300' }],
      [{ text: '🔎 10 групп (500+ уч.)', callback_data: 'f_run:10:500' }, { text: '🔎 20 групп (500+ уч.)', callback_data: 'f_run:20:500' }],
      [{ text: '♻️ Сбросить выданные ссылки', callback_data: 'f_reset_shown' }]
    ]
  };
}

function buildFinderPanelText() {
  let shown = 0, closed = 0, dead = 0;
  for (const v of knownGroups.values()) {
    if (v.dead) dead++;
    else if (v.closed) closed++;
    else if (v.shown) shown++;
  }
  const avail = Math.max(0, EMBEDDED_LINKS.length - shown - closed - dead);
  return (
    `🔎 Поиск открытых групп (без авто-входа)\n\n` +
    `📚 Всего в базе: ${EMBEDDED_LINKS.length} шт.\n` +
    `✅ Уже выдано тебе: ${shown} шт.\n` +
    `🔒 Закрытых/по заявке: ${closed} шт.\n` +
    `❌ Нерабочих: ${dead} шт.\n` +
    `⏳ Доступно для поиска: ${avail} шт.\n\n` +
    `✍️ Напиши два числа через пробел: [сколько групп] [минимум людей]\nНапример: 10 500`
  );
}

function getVisibleUserIds(viewerId) {
  const all = new Set([...sessions.keys(), ...bannedUsers, ...usersMeta.keys(), ...SUB_ADMINS]);
  all.delete(OWNER_ID);
  if (!isOwner(viewerId)) SUB_ADMINS.forEach((id) => all.delete(id));
  return [...all];
}

function buildAdminKeyboard(viewerId) {
  const rows = [];
  for (const id of getVisibleUserIds(viewerId)) {
    const s = sessions.get(id), m = usersMeta.get(id) || {};
    const banned = bannedUsers.has(id), conn = Boolean(s?.isConnected);
    const name = (s?.name || m.name || `ID:${id}`).slice(0, 14);
    rows.push([{ text: `${banned ? '🚫' : conn ? '🟢' : '🔴'} ${isSubAdmin(id) ? '⭐️ ' : ''}${name} (${id})`, callback_data: 'noop' }]);
    const act = [];
    if (banned) act.push({ text: '✅ Разбан', callback_data: `adm_unban:${id}` });
    else {
      if (conn) act.push({ text: '🔌 Кик WA', callback_data: `adm_kick:${id}` });
      act.push({ text: '🔨 Бан', callback_data: `adm_ban:${id}` }, { text: '🔄 Сброс', callback_data: `adm_reset:${id}` });
    }
    act.push({ text: '🗑 Удалить', callback_data: `adm_del:${id}` });
    rows.push(act);
  }
  rows.push([{ text: '📢 Написать всем', callback_data: 'adm_msg_all' }, { text: '🔄 Обновить', callback_data: 'adm_refresh' }]);
  return { inline_keyboard: rows };
}

function buildAdminText(viewerId) {
  const ids = getVisibleUserIds(viewerId);
  const vs = sessions.get(Number(viewerId));
  let t = `👑 Панель (${isOwner(viewerId) ? 'Главный Создатель' : 'Админ'})\n`;
  t += `Твой WA: ${vs?.isConnected ? `🟢 (${vs.groupsCache.length} гр.)` : '🔴'}\n`;
  t += `Слоты: ${countConnectedClients()}/${MAX_USERS}\n\n`;
  if (!ids.length) return t + 'Пользователей пока нет.';
  for (const id of ids) {
    const s = sessions.get(id), m = usersMeta.get(id) || {};
    const st = bannedUsers.has(id) ? '🚫 БАН' : s?.isConnected ? `🟢 (${s.groupsCache.length} гр.)` : '🔴 Офф';
    t += `• ${isSubAdmin(id) ? '⭐️ ' : ''}${s?.name || m.name || 'Без имени'} ${s?.username || m.username || ''} [${id}] — ${st}\n`;
  }
  return t;
}

function buildSingleGroupKeyboard(s, page = 0) {
  const avail = s.groupsCache.map((g, idx) => ({ ...g, idx })).filter((g) => !s.excludedGroups.has(String(g.id)));
  const pages = Math.max(1, Math.ceil(avail.length / PAGE_SIZE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const rows = avail.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE).map((g) => [{ text: `💬 ${g.subject.slice(0, 42)}`, callback_data: `send_one:${g.idx}` }]);
  const nav = [];
  if (cur > 0) nav.push({ text: '⬅️', callback_data: `b_one_page:${cur - 1}` });
  nav.push({ text: `${cur + 1}/${pages}`, callback_data: 'noop' });
  if (cur < pages - 1) nav.push({ text: '➡️', callback_data: `b_one_page:${cur + 1}` });
  rows.push(nav, [{ text: '🔙 Назад', callback_data: 'b_back' }]);
  return { inline_keyboard: rows };
}

async function renderExclusionsMenu(chatId, s, page = 0, mode = 'm', msgId = null) {
  const total = s.groupsCache.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const start = cur * PAGE_SIZE;
  const exclCount = s.groupsCache.filter((g) => s.excludedGroups.has(String(g.id))).length;
  const rows = s.groupsCache.slice(start, start + PAGE_SIZE).map((g, i) => {
    const ex = s.excludedGroups.has(String(g.id));
    return [{ text: `${ex ? '🚫 [ИСКЛ]' : '✅ [АКТИВ]'} ${g.subject.slice(0, 36)}`, callback_data: `excl_tog:${start + i}:${cur}:${mode}` }];
  });
  const nav = [];
  if (cur > 0) nav.push({ text: '⬅️', callback_data: `excl_open:${cur - 1}:${mode}` });
  nav.push({ text: `${cur + 1}/${pages}`, callback_data: 'noop' });
  if (cur < pages - 1) nav.push({ text: '➡️', callback_data: `excl_open:${cur + 1}:${mode}` });
  rows.push(nav);
  if (exclCount > 0) rows.push([{ text: `🗑 Очистить все (${exclCount})`, callback_data: `excl_clear:${cur}:${mode}` }]);
  if (mode === 'b') rows.push([{ text: '🔙 К рассылке', callback_data: 'b_back' }]);
  const text = `🚫 Исключения | Всего: ${total} | Искл: ${exclCount}`;
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

function destroySocket(s) {
  if (!s) return;
  s.isStopped = true;
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.sock) { try { s.sock.ev.removeAllListeners(); s.sock.ws.close(); } catch (_) {} s.sock = null; }
  s.isConnected = false; s.isConnecting = false;
}

function clearUserAuthFolder(id) {
  try { const d = getUserAuthDir(id); if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
}

async function refreshGroupsCache(s) {
  if (!s.sock || !s.isConnected) throw new Error('WA не подключен');
  const p = await s.sock.groupFetchAllParticipating();
  s.groupsCache = Object.values(p).map((g) => ({ id: String(g.id), subject: g.subject || 'Без названия' })).sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
  return s.groupsCache;
}

async function ensureGroupsLoaded(id, s) {
  if (!s.excludedGroups.size) loadExcluded(id, s);
  if (!s.groupsCache.length && s.isConnected) { try { await refreshGroupsCache(s); } catch (_) {} }
}

async function sendQrCode(id, qr, caption) {
  try { const buf = await QRCode.toBuffer(qr, { scale: 8, margin: 2 }); await bot.sendPhoto(id, buf, { caption }); } catch (_) {}
}

async function startWhatsAppSession(chatId, opts = {}) {
  const id = Number(chatId);
  const s = getUserSession(id);
  if (opts.reset) {
    destroySocket(s); clearUserAuthFolder(id);
    s.pairingSent = false; s.qrCount = 0; s.phoneNumber = opts.phoneNumber || null; s.forceQr = Boolean(opts.forceQr);
  }
  if (s.isConnecting) return;
  s.isConnecting = true; s.isStopped = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(getUserAuthDir(id));
    let version = [2, 3000, 1015901307];
    try { const l = await fetchLatestBaileysVersion(); if (l?.version) version = l.version; } catch (_) {}

    const sock = makeWASocket({
      version, logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false,
      getMessage: async () => ({ conversation: '' })
    });

    s.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (upd) => {
      if (s.isStopped) return;
      const { connection, lastDisconnect, qr } = upd;
      if (qr && !state.creds.registered) {
        if (s.phoneNumber && !s.forceQr) {
          if (!s.pairingSent) {
            s.pairingSent = true;
            try {
              await delay(1000);
              const raw = await sock.requestPairingCode(s.phoneNumber);
              const code = raw?.match(/.{1,4}/g)?.join('-') || raw;
              await bot.sendMessage(id, `🔐 Код сопряжения:\n\n👉 ${code} 👈\n\nWhatsApp -> Связанные устройства -> Привязка по номеру телефона.`, {
                reply_markup: { inline_keyboard: [[{ text: '📷 QR-код', callback_data: 'force_qr' }]] }
              }).catch(() => {});
            } catch (_) { s.forceQr = true; await sendQrCode(id, qr, '⚠️ QR-код:'); }
          }
        } else {
          s.qrCount++;
          if (s.qrCount <= 3) await sendQrCode(id, qr, `📷 QR-код (${s.qrCount}/3):`);
          else { destroySocket(s); clearUserAuthFolder(id); await bot.sendMessage(id, '⌛ Время QR истекло.', getMainMenuKeyboard(id)).catch(() => {}); }
        }
      }
      if (connection === 'open') {
        s.isConnected = true; s.wasEverConnected = true; s.isConnecting = false;
        s.pairingSent = false; s.phoneNumber = null; s.qrCount = 0;
        loadExcluded(id, s);
        try { await refreshGroupsCache(s); } catch (_) {}
        await bot.sendMessage(id, `✅ WhatsApp подключен! Групп: ${s.groupsCache.length}`, getMainMenuKeyboard(id)).catch(() => {});
      }
      if (connection === 'close') {
        const wasConn = s.wasEverConnected;
        s.isConnected = false; s.isConnecting = false;
        if (s.isStopped) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        const msg = String(lastDisconnect?.error?.message || lastDisconnect?.error || '');
        if (code === DisconnectReason.loggedOut || code === 401 || code === 403 || msg.includes('Bad MAC')) {
          destroySocket(s); clearUserAuthFolder(id); s.groupsCache = [];
          if (wasConn) { s.wasEverConnected = false; await bot.sendMessage(id, '🔴 Сессия WhatsApp завершена.', getMainMenuKeyboard(id)).catch(() => {}); }
          return;
        }
        if (state?.creds?.registered || s.pairingSent || code === DisconnectReason.restartRequired || code === 515) {
          s.reconnectTimer = setTimeout(() => { if (!s.isStopped) startWhatsAppSession(id, { reset: false }); }, code === 515 ? 1200 : 4000);
        } else { destroySocket(s); clearUserAuthFolder(id); }
      }
    });
  } catch (e) { s.isConnecting = false; await bot.sendMessage(id, `❌ Ошибка: ${e.message}`).catch(() => {}); }
}

async function runGroupFinder(chatId, targetCount = 10, minMembers = 500) {
  if (!isOwner(chatId)) return;
  const s = getUserSession(chatId);
  if (!s.sock || !s.isConnected) return bot.sendMessage(chatId, '❌ Сначала подключи WhatsApp!').catch(() => {});
  if (s.isSearching) return bot.sendMessage(chatId, '⏳ Поиск уже идёт!').catch(() => {});

  await ensureGroupsLoaded(chatId, s);
  const myGroups = new Set(s.groupsCache.map((g) => String(g.id)));

  s.isSearching = true; s.stopSearch = false; s.step = 'IDLE';
  const found = [];
  let checked = 0, small = 0, closed = 0, dead = 0, lastUi = 0;

  const statusMsg = await bot.sendMessage(
    chatId,
    `🔎 Ищу ${targetCount} открытых групп (${minMembers}+ уч.)...`,
    { reply_markup: { inline_keyboard: [[{ text: '🛑 Остановить поиск', callback_data: 'f_stop' }]] } }
  ).catch(() => null);

  function updUi(act, force = false) {
    if (!statusMsg) return;
    const now = Date.now();
    if (!force && now - lastUi < 2500) return;
    lastUi = now;
    bot.editMessageText(
      `🔎 Поиск открытых групп (${minMembers}+ уч.)\n\n` +
      `✅ Найдено: ${found.length} из ${targetCount}\n` +
      `📊 Проверено: ${checked} | Мелких: ${small}\n` +
      `🔒 Закрытых: ${closed} | ❌ Битых: ${dead}\n\n📌 ${act}`,
      { chat_id: chatId, message_id: statusMsg.message_id, reply_markup: { inline_keyboard: [[{ text: '🛑 Остановить поиск', callback_data: 'f_stop' }]] } }
    ).catch(() => {});
  }

  for (let i = 0; i < EMBEDDED_LINKS.length; i++) {
    if (s.stopSearch || !s.isConnected || !s.sock) break;
    if (found.length >= targetCount) break;

    const { num, code } = EMBEDDED_LINKS[i];
    if (code.length < 20) { knownGroups.set(num, { dead: true }); dead++; continue; }

    if (knownGroups.has(num)) {
      const c = knownGroups.get(num);
      if (c.dead) { dead++; continue; }
      if (c.closed) { closed++; continue; }
      if (c.shown || (c.gid && myGroups.has(c.gid))) continue;
      if (typeof c.size === 'number' && c.size < minMembers) { small++; continue; }
      if (c.open && c.size >= minMembers) {
        c.shown = true;
        knownGroups.set(num, c);
        found.push({ num, title: c.title || `Группа №${num}`, size: c.size, link: `https://chat.whatsapp.com/${code}` });
        continue;
      }
    }

    checked++;
    try {
      const info = await s.sock.groupGetInviteInfo(code);
      const gid = info?.id ? String(info.id) : '';
      const title = (info?.subject || `Группа №${num}`).replace(/\r?\n/g, ' ').trim();
      const size = Number(info?.size || 0);
      const isClosed = Boolean(info?.announce || info?.isCommunityAnnounce || info?.joinApprovalMode || info?.membershipApprovalMode);

      if (gid && myGroups.has(gid)) {
        knownGroups.set(num, { open: !isClosed, size, title, gid, shown: true });
        await delay(SCAN_DELAY_MS);
        continue;
      }
      if (isClosed) {
        closed++;
        knownGroups.set(num, { closed: true, size, title, gid });
        updUi(`Закрыта №${num}`);
        await delay(SCAN_DELAY_MS);
        continue;
      }
      if (size < minMembers) {
        small++;
        knownGroups.set(num, { open: true, size, title, gid, shown: false });
        updUi(`Мало людей №${num} (${size} уч.)`);
        await delay(SCAN_DELAY_MS);
        continue;
      }

      knownGroups.set(num, { open: true, size, title, gid, shown: true });
      found.push({ num, title, size, link: `https://chat.whatsapp.com/${code}` });
      saveKnown();
      updUi(`✅ Найдена №${num} (${size} уч.)`, true);
      await delay(SCAN_DELAY_MS);
    } catch (err) {
      const m = String(err?.message || err || '');
      if (m.includes('401') || m.includes('404') || m.includes('410') || m.includes('gone') || m.includes('not-authorized') || m.includes('bad-request')) {
        knownGroups.set(num, { dead: true });
      }
      dead++;
      updUi(`Нерабочая №${num}`);
      await delay(SCAN_DELAY_MS);
    }
  }

  saveKnown();
  s.isSearching = false; s.stopSearch = false;

  if (!found.length) {
    return bot.sendMessage(chatId, `🏁 Поиск завершён. Подходящих открытых групп (${minMembers}+ уч.) не найдено.`, getMainMenuKeyboard(chatId)).catch(() => {});
  }

  let chunk = `✅ Найдено открытых групп: ${found.length} (от ${minMembers}+ уч.)\n\n`;
  for (let idx = 0; idx < found.length; idx++) {
    const g = found[idx];
    const line = `${idx + 1}. [Ссылка №${g.num}] ${g.title}\n👥 Участников: ${g.size}\n🔗 ${g.link}\n\n`;
    if ((chunk + line).length > 3800) {
      await bot.sendMessage(chatId, chunk, { disable_web_page_preview: true }).catch(() => {});
      chunk = '';
    }
    chunk += line;
  }
  if (chunk) await bot.sendMessage(chatId, chunk, { disable_web_page_preview: true, ...getMainMenuKeyboard(chatId) }).catch(() => {});
}

async function broadcastMessage(chatId, s, targets) {
  if (!s.sock || !s.isConnected) return bot.sendMessage(chatId, '❌ WhatsApp не подключен.').catch(() => {});
  if (s.isBroadcasting) return bot.sendMessage(chatId, '⏳ Дождитесь конца рассылки!').catch(() => {});
  if (!targets.length) return bot.sendMessage(chatId, '⚠️ Нет групп для рассылки.').catch(() => {});

  const { type, text, fileId } = s.draft;
  if (type === 'text' && (!text || !text.trim())) return bot.sendMessage(chatId, '⚠️ Пустой текст.').catch(() => {});

  s.isBroadcasting = true;
  let ok = 0, fail = 0, statusMsg = null;
  try {
    statusMsg = await bot.sendMessage(chatId, `⏳ Рассылка по ${targets.length} группам (КД 15 сек)...`).catch(() => null);
    let buf = null;
    if ((type === 'photo' || type === 'video') && fileId) {
      const link = await bot.getFileLink(fileId);
      buf = await downloadBuffer(link);
    }
    for (let i = 0; i < targets.length; i++) {
      if (!s.isConnected || !s.sock) { fail += targets.length - i; break; }
      try {
        if (type === 'photo' && buf) await s.sock.sendMessage(targets[i].id, { image: buf, caption: text || '' });
        else if (type === 'video' && buf) await s.sock.sendMessage(targets[i].id, { video: buf, caption: text || '' });
        else await s.sock.sendMessage(targets[i].id, { text: text || '' });
        ok++;
      } catch (_) { fail++; }
      if (i < targets.length - 1) await delay(BROADCAST_DELAY_MS + Math.floor(Math.random() * 1000));
    }
    const res = `✅ Рассылка завершена!\n📤 Успешно: ${ok}\n❌ Ошибок: ${fail}`;
    if (statusMsg) await bot.editMessageText(res, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => bot.sendMessage(chatId, res).catch(() => {}));
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`).catch(() => {});
  } finally { s.isBroadcasting = false; }
}

async function sendDraftPreview(chatId, s, msgId = null) {
  const h = s.draft.type === 'photo' ? '🖼 Фото сохранено!' : s.draft.type === 'video' ? '🎬 Видео сохранено!' : '📝 Текст сохранён!';
  const txt = `${h}\n\n${s.draft.text || '(без подписи)'}\n\n👇 Выберите действие:`;
  if (msgId) return bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, reply_markup: getBroadcastMenuKeyboard() }).catch(() => {});
  return bot.sendMessage(chatId, txt, { reply_markup: getBroadcastMenuKeyboard() }).catch(() => {});
}

bot.onText(/^\/start/, async (msg) => {
  const id = Number(msg.chat.id);
  updateUserInfo(msg);
  if (bannedUsers.has(id) && !isOwner(id)) return bot.sendMessage(id, '⛔ Доступ закрыт.').catch(() => {});
  const s = getUserSession(id);
  s.step = 'IDLE';
  await ensureGroupsLoaded(id, s);

  if (!isOwner(id) && !s.notifiedOwner) {
    s.notifiedOwner = true;
    usersMeta.set(id, { name: s.name, username: s.username, notifiedOwner: true });
    saveUsersMeta();
    bot.sendMessage(OWNER_ID, `🔔 Новый клиент: ${s.name} ${s.username} [${id}]`).catch(() => {});
  }

  let t = `👋 Панель управления WhatsApp\n\nСтатус: ${s.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\nГрупп: ${s.groupsCache.length} | Искл: ${s.excludedGroups.size}\nСлоты: ${Math.max(0, MAX_USERS - countConnectedClients())}/${MAX_USERS}\n`;
  if (isOwner(id)) t += `База ссылок: ${EMBEDDED_LINKS.length} шт.\n`;
  t += `\nОтправьте текст, фото или видео для рассылки:`;
  await bot.sendMessage(id, t, getMainMenuKeyboard(id)).catch(() => {});
});

bot.on('message', async (msg) => {
  const id = Number(msg.chat.id);
  const text = msg.text ? msg.text.trim() : '';
  if (text.startsWith('/start')) return;
  updateUserInfo(msg);
  if (bannedUsers.has(id) && !isOwner(id)) return bot.sendMessage(id, '⛔ Доступ закрыт.').catch(() => {});

  const s = getUserSession(id);

  if (isAdmin(id) && s.step === 'AWAITING_ADMIN_BROADCAST' && text) {
    s.step = 'IDLE';
    if (text === 'Отмена' || text === '👑 Админ-панель') return bot.sendMessage(id, '❌ Отменено.', getMainMenuKeyboard(id)).catch(() => {});
    let sent = 0;
    for (const uid of getVisibleUserIds(id)) {
      if (!bannedUsers.has(uid)) { try { await bot.sendMessage(uid, `📢 Сообщение от админа:\n\n${text}`); sent++; } catch (_) {} }
    }
    return bot.sendMessage(id, `✅ Доставлено: ${sent}`, getMainMenuKeyboard(id)).catch(() => {});
  }

  if (text === '👑 Админ-панель' && isAdmin(id)) {
    s.step = 'IDLE';
    return bot.sendMessage(id, buildAdminText(id), { reply_markup: buildAdminKeyboard(id) }).catch(() => {});
  }

  if (text === '🔎 Найти группы') {
    if (!isOwner(id)) return bot.sendMessage(id, '❌ Только для Создателя.').catch(() => {});
    s.step = 'AWAITING_FINDER_PARAMS';
    return bot.sendMessage(id, buildFinderPanelText(), { reply_markup: getFinderKeyboard(s) }).catch(() => {});
  }

  if (s.step === 'AWAITING_FINDER_PARAMS' && text && !['Войти в аккаунт', 'Список групп', 'Обновить список групп', 'Список исключение', 'Выйти из ватсап', '👑 Админ-панель'].includes(text)) {
    if (!isOwner(id)) { s.step = 'IDLE'; return; }
    const nums = text.match(/\d+/g);
    if (!nums || !nums.length) return bot.sendMessage(id, '⚠️ Введи два числа через пробел, например: 10 500').catch(() => {});
    const count = Math.max(1, Math.min(100, parseInt(nums[0], 10)));
    const minMem = nums.length >= 2 ? Math.max(1, parseInt(nums[1], 10)) : 500;
    s.step = 'IDLE';
    return runGroupFinder(id, count, minMem);
  }

  if (text === 'Войти в аккаунт') {
    if (s.isConnected) return bot.sendMessage(id, '🟢 Уже подключен!', getMainMenuKeyboard(id)).catch(() => {});
    if (!isAdmin(id) && countConnectedClients() >= MAX_USERS && !fs.existsSync(getUserAuthDir(id))) {
      return bot.sendMessage(id, `⚠️ Все слоты заняты (${MAX_USERS}/${MAX_USERS}).`).catch(() => {});
    }
    s.step = 'AWAITING_PHONE';
    return bot.sendMessage(id, '📱 Введите номер WhatsApp начиная с 7 (например: 79298892099):', {
      reply_markup: { inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]] }
    }).catch(() => {});
  }

  if (text === 'Список групп') {
    s.step = 'IDLE';
    if (!s.isConnected) return bot.sendMessage(id, '🔴 WhatsApp не подключен.').catch(() => {});
    await ensureGroupsLoaded(id, s);
    if (!s.groupsCache.length) return bot.sendMessage(id, '📭 Групп нет.').catch(() => {});
    let chunk = `📋 Ваши группы (${s.groupsCache.length}):\n\n`;
    for (let i = 0; i < s.groupsCache.length; i++) {
      const g = s.groupsCache[i];
      const line = `${i + 1}. ${g.subject}${s.excludedGroups.has(String(g.id)) ? ' 🚫' : ''}\n`;
      if ((chunk + line).length > 3800) { await bot.sendMessage(id, chunk).catch(() => {}); chunk = ''; }
      chunk += line;
    }
    if (chunk) await bot.sendMessage(id, chunk).catch(() => {});
    return;
  }

  if (text === 'Обновить список групп') {
    s.step = 'IDLE';
    if (!s.isConnected) return bot.sendMessage(id, '🔴 WhatsApp не подключен.').catch(() => {});
    const w = await bot.sendMessage(id, '🔄 Обновляю...').catch(() => null);
    try {
      await refreshGroupsCache(s);
      if (w) await bot.editMessageText(`✅ Обновлено! Групп: ${s.groupsCache.length}`, { chat_id: id, message_id: w.message_id }).catch(() => {});
    } catch (e) {
      if (w) await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: id, message_id: w.message_id }).catch(() => {});
    }
    return;
  }

  if (text === 'Список исключение' || text === 'Список исключений') {
    s.step = 'IDLE';
    if (!s.isConnected) return bot.sendMessage(id, '🔴 Сначала подключите WhatsApp.').catch(() => {});
    await ensureGroupsLoaded(id, s);
    if (!s.groupsCache.length) return bot.sendMessage(id, '📭 Групп нет.').catch(() => {});
    return renderExclusionsMenu(id, s, 0, 'm', null);
  }

  if (text === 'Выйти из ватсап') {
    s.step = 'IDLE'; s.wasEverConnected = false;
    if (s.sock) { try { await s.sock.logout().catch(() => {}); } catch (_) {} }
    destroySocket(s); clearUserAuthFolder(id); s.groupsCache = [];
    return bot.sendMessage(id, '👋 Сессия удалена.', getMainMenuKeyboard(id)).catch(() => {});
  }

  if (s.step === 'AWAITING_PHONE' && text) {
    let ph = text.replace(/\D/g, '');
    if (ph.length === 11 && ph.startsWith('8')) ph = '7' + ph.slice(1);
    if (ph.length < 10 || ph.length > 15) return bot.sendMessage(id, '⚠️ Введите номер начиная с 7:').catch(() => {});
    s.step = 'IDLE';
    await bot.sendMessage(id, `⏳ Запрашиваю код для +${ph}...`).catch(() => {});
    return startWhatsAppSession(id, { reset: true, phoneNumber: ph, forceQr: false });
  }

  if (!s.isConnected) return bot.sendMessage(id, '⚠️ Сначала подключите WhatsApp.', getMainMenuKeyboard(id)).catch(() => {});
  await ensureGroupsLoaded(id, s);

  if (msg.photo?.length) {
    s.draft = { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, text: msg.caption || '' };
    return sendDraftPreview(id, s);
  }
  if (msg.video) {
    s.draft = { type: 'video', fileId: msg.video.file_id, text: msg.caption || '' };
    return sendDraftPreview(id, s);
  }
  if (text) {
    s.draft = { type: 'text', fileId: null, text };
    return sendDraftPreview(id, s);
  }
});

bot.on('callback_query', async (q) => {
  if (!q.message) return bot.answerCallbackQuery(q.id).catch(() => {});
  const id = Number(q.message.chat.id), msgId = q.message.message_id, data = q.data || '';
  if (bannedUsers.has(id) && !isOwner(id)) return bot.answerCallbackQuery(q.id, { text: 'Доступ закрыт.', show_alert: true }).catch(() => {});
  const s = getUserSession(id);
  if (data === 'noop') return bot.answerCallbackQuery(q.id).catch(() => {});

  if (data === 'f_stop') {
    if (!isOwner(id)) return;
    s.stopSearch = true;
    return bot.answerCallbackQuery(q.id, { text: 'Останавливаю поиск...' }).catch(() => {});
  }
  if (data.startsWith('f_run:')) {
    if (!isOwner(id)) return;
    const [, c, m] = data.split(':');
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return runGroupFinder(id, parseInt(c, 10) || 10, parseInt(m, 10) || 500);
  }
  if (data === 'f_reset_shown') {
    if (!isOwner(id)) return;
    for (const [k, v] of knownGroups.entries()) {
      if (v.shown) { v.shown = false; knownGroups.set(k, v); }
    }
    saveKnown();
    await bot.answerCallbackQuery(q.id, { text: 'Выданные ссылки сброшены!' }).catch(() => {});
    return bot.editMessageText(buildFinderPanelText(), { chat_id: id, message_id: msgId, reply_markup: getFinderKeyboard(s) }).catch(() => {});
  }

  if (data.startsWith('adm_') && isAdmin(id)) {
    if (data === 'adm_refresh') {
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return bot.editMessageText(buildAdminText(id), { chat_id: id, message_id: msgId, reply_markup: buildAdminKeyboard(id) }).catch(() => {});
    }
    if (data === 'adm_msg_all') {
      s.step = 'AWAITING_ADMIN_BROADCAST';
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return bot.sendMessage(id, '📢 Введите сообщение для всех (или Отмена):').catch(() => {});
    }
    const [act, tidStr] = data.split(':');
    const tid = Number(tidStr);
    if (isOwner(tid) || (!isOwner(id) && isSubAdmin(tid))) {
      return bot.answerCallbackQuery(q.id, { text: '⛔ Нет прав!', show_alert: true }).catch(() => {});
    }
    const ts = sessions.get(tid);
    if (act === 'adm_kick' || act === 'adm_ban' || act === 'adm_reset' || act === 'adm_del') {
      if (ts) {
        ts.wasEverConnected = false;
        if (ts.sock && act !== 'adm_reset') { try { await ts.sock.logout().catch(() => {}); } catch (_) {} }
        destroySocket(ts); ts.groupsCache = [];
      }
      clearUserAuthFolder(tid);
    }
    if (act === 'adm_ban') { bannedUsers.add(tid); saveBanned(); bot.sendMessage(tid, '⛔ Доступ закрыт.').catch(() => {}); }
    if (act === 'adm_unban') { bannedUsers.delete(tid); saveBanned(); bot.sendMessage(tid, '✅ Доступ открыт! /start').catch(() => {}); }
    if (act === 'adm_del') { sessions.delete(tid); bannedUsers.delete(tid); usersMeta.delete(tid); saveBanned(); saveUsersMeta(); }
    await bot.answerCallbackQuery(q.id, { text: 'Готово' }).catch(() => {});
    return bot.editMessageText(buildAdminText(id), { chat_id: id, message_id: msgId, reply_markup: buildAdminKeyboard(id) }).catch(() => {});
  }

  if (data === 'force_qr') {
    s.step = 'IDLE';
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return startWhatsAppSession(id, { reset: true, phoneNumber: null, forceQr: true });
  }

  await ensureGroupsLoaded(id, s);
  if (data === 'b_back') { await bot.answerCallbackQuery(q.id).catch(() => {}); return sendDraftPreview(id, s, msgId); }
  if (data.startsWith('b_one_page:')) {
    const p = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return bot.editMessageText(`🎯 Выберите группу (Стр. ${p + 1}):`, { chat_id: id, message_id: msgId, reply_markup: buildSingleGroupKeyboard(s, p) }).catch(() => {});
  }
  if (data.startsWith('send_one:')) {
    const g = s.groupsCache[parseInt(data.split(':')[1], 10)];
    if (!g) return bot.answerCallbackQuery(q.id, { text: 'Не найдена', show_alert: true }).catch(() => {});
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return broadcastMessage(id, s, [g]);
  }
  if (data === 'b_rand10') {
    const av = s.groupsCache.filter((g) => !s.excludedGroups.has(String(g.id)));
    for (let i = av.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [av[i], av[j]] = [av[j], av[i]]; }
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return broadcastMessage(id, s, av.slice(0, 10));
  }
  if (data === 'b_all') {
    const av = s.groupsCache.filter((g) => !s.excludedGroups.has(String(g.id)));
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return broadcastMessage(id, s, av);
  }
  if (data.startsWith('excl_open:')) {
    const [, p, m] = data.split(':');
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return renderExclusionsMenu(id, s, parseInt(p, 10) || 0, m || 'm', msgId);
  }
  if (data.startsWith('excl_tog:')) {
    const [, idx, p, m] = data.split(':');
    const g = s.groupsCache[parseInt(idx, 10)];
    if (!g) return bot.answerCallbackQuery(q.id, { text: 'Обновите список' }).catch(() => {});
    const gid = String(g.id);
    if (s.excludedGroups.has(gid)) s.excludedGroups.delete(gid); else s.excludedGroups.add(gid);
    saveExcluded(id, s);
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return renderExclusionsMenu(id, s, parseInt(p, 10) || 0, m || 'm', msgId);
  }
  if (data.startsWith('excl_clear:')) {
    const [, p, m] = data.split(':');
    s.excludedGroups.clear(); saveExcluded(id, s);
    await bot.answerCallbackQuery(q.id, { text: 'Очищено!' }).catch(() => {});
    return renderExclusionsMenu(id, s, parseInt(p, 10) || 0, m || 'm', msgId);
  }
});

(async () => {
  await startPolling();
  try {
    for (const f of fs.readdirSync(__dirname)) {
      if (f.startsWith('auth_info_')) {
        const id = Number(f.replace('auth_info_', ''));
        const cf = path.join(__dirname, f, 'creds.json');
        if (id && (!bannedUsers.has(id) || isOwner(id)) && fs.existsSync(cf)) {
          try {
            if (JSON.parse(fs.readFileSync(cf, 'utf-8'))?.registered) startWhatsAppSession(id, { reset: false });
            else clearUserAuthFolder(id);
          } catch (_) { clearUserAuthFolder(id); }
        }
      }
    }
  } catch (_) {}
})();
